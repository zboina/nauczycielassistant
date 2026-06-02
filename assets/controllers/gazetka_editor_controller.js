import { Controller } from '@hotwired/stimulus';

/*
 * Edytor gazetki szkolnej — strony A5 (A4 składane na pół).
 * Renderowanie i interakcja: Konva (globalne window.Konva, ładowane z CDN w szablonie).
 * Eksport PDF z impozycją: pdf-lib (globalne window.PDFLib).
 *
 * Wszystkie współrzędne elementów są w punktach (pt), tak samo jak strona (A5 = 420×595 pt),
 * dzięki czemu edytor i eksport PDF mają identyczną geometrię.
 */
export default class extends Controller {
    static targets = ['container', 'thumbs', 'title', 'file', 'status', 'props', 'zoomLabel', 'pageInfo', 'gridBtn', 'gridSizeInput', 'undoBtn', 'redoBtn', 'cropContainer', 'toolbar', 'projectFile', 'pageFile', 'layers', 'layersBtn'];
    static values = {
        saveUrl: String,
        uploadUrl: String,
        aiTextUrl: String,
        aiRedactUrl: String,
        aiImageUrl: String,
        stockSearchUrl: String,
        stockImportUrl: String,
        mediaListUrl: String,
        mediaDeleteUrl: String,
        blocksUrl: String,
        pageTemplatesUrl: String,
        importCreateUrl: String,
        csrf: String,
        doc: Object,
        initialTemplate: String,
    };

    connect() {
        if (!window.Konva) {
            this.statusTarget.textContent = 'Błąd: nie załadowano biblioteki Konva.';
            return;
        }
        this.Konva = window.Konva;

        const incoming = this.docValue;
        this.doc = incoming && Array.isArray(incoming.pages) && incoming.pages.length
            ? incoming
            : { version: 1, pageW: 420, pageH: 595, pages: [{ background: '#ffffff', elements: [] }] };
        this.pageW = this.doc.pageW || 420;
        this.pageH = this.doc.pageH || 595;
        if (!this.doc.pageNumbers) this.doc.pageNumbers = { show: false, position: 'outer' };
        if (!this.doc.guides || !Array.isArray(this.doc.guides.h) || !Array.isArray(this.doc.guides.v)) {
            this.doc.guides = { h: [], v: [] };
        }

        this.current = 0;
        this.selectedId = null;
        this.selectedIds = [];      // pełna selekcja (1 = pojedyncza, >1 = wielokrotna/grupa)
        this.imageCache = {};
        this.dirty = false;
        this.clipboard = null;
        // Krok siatki w pt — wartość zapisywana w dokumencie (per-gazetka). Domyślnie 20.
        this.gridSize = (this.doc.gridSize && this.doc.gridSize > 0) ? this.doc.gridSize : 20;
        this.snap = true;
        this.history = [];
        this.histIdx = -1;
        this._histTimer = null;
        this._restoring = false;

        this.zoom = this.fitZoom();
        this.initStage();
        this.bindGlobalKeys();
        this.renderThumbs();
        this.renderPage();
        this.updateZoomLabel();

        // Pasek narzędzi: przywróć zapisany stan (rozwinięty z opisami / zwinięty same ikony).
        try { this._toolbarExpanded = localStorage.getItem('gzToolbarExpanded') === '1'; } catch (e) { this._toolbarExpanded = false; }
        this.applyToolbarState();

        // Ustaw kontrolkę numeracji stron zgodnie z dokumentem.
        const pnSel = this.element.querySelector('[data-pagenum]');
        if (pnSel) pnSel.value = this.doc.pageNumbers.show ? this.doc.pageNumbers.position : 'off';

        // Sync input rozmiaru siatki (gdy doc miał własny zapisany krok).
        if (this.hasGridSizeInputTarget) { this.gridSizeInputTarget.value = String(this.gridSize); }

        // Szablon pierwszej strony wybrany przy tworzeniu gazetki.
        if (this.hasInitialTemplateValue && this.initialTemplateValue && this.page().elements.length === 0) {
            this.applyTemplateKey(this.initialTemplateValue, false);
        }

        this.snapshotNow(); // bazowy stan historii (cofania)

        this._autosave = setInterval(() => { if (this.dirty) this.save(); }, 15000);
        this._beforeUnload = (e) => {
            if (this.dirty) { e.preventDefault(); e.returnValue = ''; }
        };
        window.addEventListener('beforeunload', this._beforeUnload);

        // Delegowana obsługa panelu właściwości.
        this.propsTarget.addEventListener('input', (e) => this.onPropInput(e));
        this.propsTarget.addEventListener('change', (e) => this.onPropInput(e));

        // Okno kadrowania — budujemy stage dopiero gdy modal w pełni widoczny (kontener ma wymiary).
        const cropModal = document.getElementById('gzCropModal');
        if (cropModal) {
            cropModal.addEventListener('shown.bs.modal', () => this.setupCrop());
            cropModal.addEventListener('hidden.bs.modal', () => {
                if (this._cropStage) { this._cropStage.destroy(); this._cropStage = null; }
                this._crop = null;
            });
        }

        // Podgląd rozkładówki — renderuj po otwarciu okna.
        const spreadModal = document.getElementById('gzSpreadModal');
        if (spreadModal) spreadModal.addEventListener('shown.bs.modal', () => this.setupSpread());

        // Przeglądarka ikon — wczytaj pełną listę po otwarciu.
        const iconModal = document.getElementById('gzIconModal');
        if (iconModal) iconModal.addEventListener('shown.bs.modal', () => this.loadIconList());

        // Okno AI — przy otwarciu sprawdź, czy zaznaczono grafikę (wzór do generowania w jej stylu).
        const aiModal = document.getElementById('gzAiModal');
        if (aiModal) aiModal.addEventListener('show.bs.modal', () => this.prepareAiRef());

        // Magazyn mediów — wczytaj listę grafik po otwarciu okna.
        const mediaModal = document.getElementById('gzMediaModal');
        if (mediaModal) {
            mediaModal.addEventListener('shown.bs.modal', () => this.loadMedia());
            // Po zamknięciu BEZ wyboru — wyczyść flagę „wypełnij ramkę" (nie wisi przy następnym otwarciu).
            mediaModal.addEventListener('hidden.bs.modal', () => { this._fillFrameId = null; });
        }

        // Magazyn bloków — odśwież paletę po otwarciu okna.
        const blocksModal = document.getElementById('gzBlocksModal');
        if (blocksModal) blocksModal.addEventListener('shown.bs.modal', () => this.renderBlockPalette());

        // Znaki specjalne — zbuduj paletę przy pierwszym otwarciu.
        const charsModal = document.getElementById('gzCharsModal');
        if (charsModal) charsModal.addEventListener('shown.bs.modal', () => this.renderCharGrid());

        // Po załadowaniu czcionek (Google Fonts) przerysuj — inaczej Konva mierzy/rysuje fallbackiem.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => { this.renderPage(); this.renderThumbs(); });
        }

        // Pływający panel warstw: drag, collapse, przywrócenie pozycji/widoczności z localStorage.
        if (this.hasLayersTarget) { this.initFloatingPanel(this.layersTarget, 'gz_layers'); }

        // Polski hyphenator — async ładowanie z CDN; po sukcesie przerysowanie strony.
        this.loadHyphenator().then((h) => { if (h) { this.renderPage(); } });
    }

    /** Ładuje lokalny bundle (Hypher + polskie wzorce TeX) przez <script> tag. */
    loadHyphenator() {
        if (this._hyphenator !== undefined) { return Promise.resolve(this._hyphenator); }
        this._hyphenator = null;
        if (window.GzHyphenator) { this._hyphenator = window.GzHyphenator; console.log('[gz] hyphenator (cache):', this._hyphenator); return Promise.resolve(this._hyphenator); }
        return new Promise((resolve) => {
            const s = document.createElement('script');
            s.src = '/vendor/hyph/gz-hyph.js';
            s.onload = () => {
                this._hyphenator = window.GzHyphenator || null;
                console.log('[gz] hyphenator załadowany:', !!this._hyphenator);
                resolve(this._hyphenator);
            };
            s.onerror = (e) => { console.warn('[gz] hyphenator nie załadowany:', e); resolve(null); };
            document.head.appendChild(s);
        });
    }

    /** Dzieli słowo na sylaby zgodne z polskimi regułami. Zwraca tablicę kawałków
     *  (np. ['wy','ko','ny','wa','nia']) lub null, jeśli słowo jest za krótkie / brak biblioteki. */
    hyphenateWord(word) {
        const h = this._hyphenator;
        if (!h || !word || word.length < 5) { return null; }
        // Hypher zwraca cz. dla pure liter; w naszych tekstach mogą być znaki interpunkcyjne.
        // Wycinamy je z brzegów, dzielimy rdzeń, sklejamy z powrotem.
        const m = word.match(/^([^\p{L}]*)(\p{L}+(?:[\p{L}'-]*\p{L})?)([^\p{L}]*)$/u);
        if (!m) { return null; }
        const [, prefix, core, suffix] = m;
        try {
            const parts = h.hyphenate(core);
            if (!Array.isArray(parts) || parts.length < 2) { return null; }
            // Dołącz prefix/suffix do pierwszego/ostatniego kawałka
            parts[0] = prefix + parts[0];
            parts[parts.length - 1] = parts[parts.length - 1] + suffix;
            return parts;
        } catch (_) { return null; }
    }

    disconnect() {
        clearInterval(this._autosave);
        window.removeEventListener('beforeunload', this._beforeUnload);
        if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);
        if (this.stage) this.stage.destroy();
    }

    // ─── Stage ──────────────────────────────────────────────

    initStage() {
        const K = this.Konva;
        this.stage = new K.Stage({
            container: this.containerTarget,
            width: this.pageW * this.zoom,
            height: this.pageH * this.zoom,
        });
        this.stage.scale({ x: this.zoom, y: this.zoom });

        this.layer = new K.Layer();
        this.guideLayer = new K.Layer(); // linie pomocnicze nad treścią, pod transformatorem
        this.ui = new K.Layer();
        this.stage.add(this.layer);
        this.stage.add(this.guideLayer);
        this.stage.add(this.ui);

        // Ctrl/⌘ + kółko myszy = zoom skoncentrowany na kursorze; bez Ctrl = normalny scroll canvas-wrap.
        this.containerTarget.addEventListener('wheel', (e) => {
            if (!e.ctrlKey && !e.metaKey) { return; }
            e.preventDefault();
            const step = 0.1;
            const dir = e.deltaY > 0 ? -step : step; // scroll down = zoom out
            this.zoomToPoint(this.zoom + dir, e.clientX, e.clientY);
        }, { passive: false });

        this.tr = new K.Transformer({
            rotateEnabled: true,
            keepRatio: false,
            anchorSize: 9,
            borderStroke: '#1a56db',
            anchorStroke: '#1a56db',
            anchorCornerRadius: 2,
            padding: 2,
            // Przyciąganie rozmiaru/pozycji podczas skalowania — do siatki (gdy włączona)
            // ORAZ do linii pomocniczych (niezależnie od siatki). Linie chwytają KRAWĘDŹ której ramka
            // jest ciągnięta (left/right dla pionowych, top/bottom dla poziomych) — analogicznie do snapPos przy drag.
            boundBoxFunc: (oldBox, newBox) => this.snapBoundBox(oldBox, newBox),
        });
        this.ui.add(this.tr);
        // Koniec skalowania/obracania (też wielu naraz): zapisz wszystkie zaznaczone węzły.
        this.tr.on('transformend', () => this.commitTransform());

        // Zaznaczanie ramką (rubber-band) na pustym tle + klik = odznacz.
        this.stage.on('mousedown touchstart', (e) => {
            if (e.target !== this.stage && e.target.name() !== 'page-bg') return;
            const pos = this.stage.getPointerPosition();
            if (!pos) return;
            this._band = { x0: pos.x / this.zoom, y0: pos.y / this.zoom, x1: pos.x / this.zoom, y1: pos.y / this.zoom, moved: false, additive: !!(e.evt && e.evt.shiftKey) };
            this._bandRect = new K.Rect({ stroke: '#1a56db', strokeWidth: 1, dash: [4, 3], fill: 'rgba(26,86,219,0.08)', listening: false });
            this.ui.add(this._bandRect);
        });
        this.stage.on('mousemove touchmove', () => {
            if (!this._band) return;
            const pos = this.stage.getPointerPosition();
            if (!pos) return;
            const x = pos.x / this.zoom, y = pos.y / this.zoom;
            this._band.x1 = x; this._band.y1 = y;
            if (Math.abs(x - this._band.x0) > 3 || Math.abs(y - this._band.y0) > 3) this._band.moved = true;
            this._bandRect.setAttrs({ x: Math.min(this._band.x0, x), y: Math.min(this._band.y0, y), width: Math.abs(x - this._band.x0), height: Math.abs(y - this._band.y0) });
            this.ui.batchDraw();
        });
        this.stage.on('mouseup touchend', () => {
            if (!this._band) return;
            const b = this._band; this._band = null;
            if (this._bandRect) { this._bandRect.destroy(); this._bandRect = null; this.ui.batchDraw(); }
            if (!b.moved) { this.select(null); return; } // zwykły klik w tło = odznacz
            const rx0 = Math.min(b.x0, b.x1), ry0 = Math.min(b.y0, b.y1), rx1 = Math.max(b.x0, b.x1), ry1 = Math.max(b.y0, b.y1);
            const hits = this.expandGroups(this.page().elements.filter((el) => this.elIntersectsRect(el, rx0, ry0, rx1, ry1)).map((el) => el.id));
            this.selectedIds = b.additive ? Array.from(new Set([...this.selectedIds, ...hits])) : hits;
            this.selectedId = this.selectedIds.length === 1 ? this.selectedIds[0] : null;
            this.reattachTransformer();
            this.syncProps();
        });
    }

    // ─── Render strony ──────────────────────────────────────

    page() {
        return this.doc.pages[this.current];
    }

    renderPage() {
        const K = this.Konva;
        this.layer.destroyChildren();

        // Tło strony.
        const bg = new K.Rect({
            name: 'page-bg',
            x: 0, y: 0, width: this.pageW, height: this.pageH,
            fill: this.page().background || '#ffffff',
            stroke: '#dfe3e8', strokeWidth: 1,
            shadowColor: 'rgba(0,0,0,0.12)', shadowBlur: 12, shadowOffsetY: 3,
        });
        this.layer.add(bg);
        this.drawGrid();

        for (const el of this.page().elements) {
            if (el.hidden) { continue; } // ukryta warstwa — pomijamy render i interakcje
            let node;
            try {
                node = this.buildNode(el, true);
            } catch (e) {
                // POJEDYNCZY element nie może wywalić całej strony — log i kontynuujemy.
                console.error('buildNode failed for element', el && el.id, e);
                node = null;
            }
            if (!node) { continue; }
            // Cień ramki obrazu — osobny element ZA Group (clipFunc Group nie współpracuje z shadow).
            // Dla prostokąta zwykły K.Rect z cornerRadius; dla innych kształtów K.Path z SVG (idzie za clipFunc-em).
            if (node._gzShadow && el.type === 'image') {
                const K = this.Konva;
                const fsh = el.frameShape || 'rect';
                if (fsh === 'rect') {
                    this.layer.add(new K.Rect({
                        x: el.x, y: el.y, width: el.width, height: el.height,
                        rotation: el.rotation || 0,
                        cornerRadius: Math.max(0, el.cornerRadius || 0),
                        fill: 'rgba(0,0,0,0.01)',
                        shadowColor: 'rgba(0,0,0,0.35)', shadowBlur: 10, shadowOffsetX: 0, shadowOffsetY: 4,
                        listening: false,
                    }));
                } else {
                    this.layer.add(new K.Path({
                        x: el.x, y: el.y,
                        rotation: el.rotation || 0,
                        data: gzShapeSvgPath(fsh, el.width, el.height, el),
                        fill: 'rgba(0,0,0,0.01)',
                        shadowColor: 'rgba(0,0,0,0.35)', shadowBlur: 10, shadowOffsetX: 0, shadowOffsetY: 4,
                        listening: false,
                    }));
                }
            }
            this.layer.add(node);
        }

        this.drawPageNumber(this.layer, this.current);
        this.layer.draw();
        this.reattachTransformer();
        this.updatePageInfo();
        this.renderLayers();
        this.renderGuides();
    }

    reattachTransformer() {
        const ids = this.selectedIds || [];
        if (!ids.length) { this.tr.nodes([]); this.ui.draw(); return; }
        const nodes = ids.map((id) => this.layer.findOne('#' + id)).filter(Boolean);
        // Skalowanie/obrót tylko dla POJEDYNCZEGO elementu. Grupa/wielokrotna selekcja:
        // sama ramka + przesuwanie (skalowanie bloku nie zmieniałoby wielkości czcionek → mylące).
        const single = nodes.length === 1;
        this.tr.resizeEnabled(single);
        this.tr.rotateEnabled(single);
        // Per-element flaga keepRatio (obecnie dla obrazu — checkbox „Zachowaj proporcje").
        const el = (single && this.selectedEl()) || null;
        this.tr.keepRatio(!!(el && el.type === 'image' && el.keepRatio));
        this.tr.nodes(nodes);
        this.ui.draw();
    }

    // ─── Budowa węzłów ──────────────────────────────────────

    buildNode(el, interactive) {
        const K = this.Konva;
        let node;

        if (el.type === 'text') {
            node = this.buildTextGroup(el, interactive);
        } else if (el.type === 'image') {
            // Image w ramce z klipowaniem — obraz może być MNIEJSZY (margines) LUB WIĘKSZY (kadr) od ramki.
            // Kształt ramki sterowany przez el.frameShape (rect|circle|ellipse|polygon-N|star-N|heart|speech|arrow-right|custom).
            const frameW = el.width, frameH = el.height;
            const radius = Math.max(0, Math.min(Math.min(frameW, frameH) / 2, el.cornerRadius || 0));
            const fshape = el.frameShape || 'rect';

            // PUSTA ramka (bez zdjęcia) — placeholder: szare wypełnienie + napis „Dwuklik = wstaw zdjęcie".
            // Kształt ramki dalej obowiązuje (klipuje placeholder).
            if (!el.src) {
                node = new K.Group({
                    width: frameW, height: frameH,
                    listening: true,
                    clipFunc: (ctx) => {
                        if (fshape === 'rect') { gzRoundedRectPath(ctx, 0, 0, frameW, frameH, radius); }
                        else { gzDrawShape(ctx, fshape, 0, 0, frameW, frameH, el); }
                    },
                });
                // Wypełnienie placeholdera (klipowane do kształtu). LISTENING domyślnie true —
                // żeby Group łapał kliki/dwukliki w pustym obszarze (bez tego Group nie rejestrował zdarzeń).
                node.add(new K.Rect({
                    x: 0, y: 0, width: frameW, height: frameH,
                    fill: '#eef1f5',
                }));
                // Diagonalne paski — wizualnie odróżniają pustą ramkę od zwykłego prostokąta
                const stripeGap = 14;
                for (let s = -frameH; s < frameW + frameH; s += stripeGap) {
                    node.add(new K.Line({
                        points: [s, 0, s + frameH, frameH],
                        stroke: '#dfe3e8', strokeWidth: 1, listening: false,
                    }));
                }
                // Etykieta (środek ramki) — ikona aparatu + tekst.
                const labelText = (frameW > 130 && frameH > 60)
                    ? '🖼 Dwuklik = wstaw zdjęcie' : (frameW > 60 ? '🖼' : '');
                if (labelText) {
                    const fs = Math.min(13, Math.max(10, frameH * 0.12));
                    node.add(new K.Text({
                        x: 0, y: frameH / 2 - fs * 0.7,
                        width: frameW, height: fs * 1.4,
                        text: labelText, align: 'center', verticalAlign: 'middle',
                        fontSize: fs, fontFamily: 'Arial, sans-serif',
                        fill: '#6c7793', listening: false,
                    }));
                }
                // Przerywany kontur (zachęca do wskazania że to PUSTA ramka)
                if (fshape === 'rect') {
                    node.add(new K.Rect({
                        x: 0, y: 0, width: frameW, height: frameH,
                        cornerRadius: radius,
                        stroke: '#9aa3af', strokeWidth: 1, dash: [5, 4],
                        listening: false,
                    }));
                } else {
                    node.add(new K.Path({
                        data: gzShapeSvgPath(fshape, frameW, frameH, el),
                        stroke: '#9aa3af', strokeWidth: 1, dash: [5, 4],
                        listening: false,
                    }));
                }
                // Catcher rect — safety net dla klików (bezpośrednio bindujemy dblclick też tutaj).
                const catcher = new K.Rect({
                    x: 0, y: 0, width: frameW, height: frameH,
                    fill: 'rgba(255,255,255,0.01)', listening: true,
                });
                catcher.on('dblclick dbltap', () => {
                    if (this.hasStatusTarget) { this.statusTarget.textContent = 'Dwuklik na pustej ramce — otwieram wybór źródła…'; }
                    this.openImageSourcePickerFor(el);
                });
                node.add(catcher);
                // Override getClientRect na bbox ramki (analogicznie do obrazu z fit).
                node.getClientRect = function (cfg) {
                    const c = cfg || {};
                    if (c.skipTransform) { return { x: 0, y: 0, width: frameW, height: frameH }; }
                    const trans = this.getAbsoluteTransform();
                    const pts = [
                        trans.point({ x: 0, y: 0 }), trans.point({ x: frameW, y: 0 }),
                        trans.point({ x: 0, y: frameH }), trans.point({ x: frameW, y: frameH }),
                    ];
                    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
                    return {
                        x: Math.min.apply(null, xs), y: Math.min.apply(null, ys),
                        width: Math.max.apply(null, xs) - Math.min.apply(null, xs),
                        height: Math.max.apply(null, ys) - Math.min.apply(null, ys),
                    };
                };
                // Wczesne wyjście — placeholder gotowy, pomijamy resztę logiki dla obrazu.
                // (poniższy blok image z img/fit/clipFunc itp. uruchamiamy tylko gdy el.src jest niepuste).
                // Reszta wspólnej obsługi (drag itp.) zachodzi w pętli wyżej.
            } else {
            const img = this.getImage(el.src);
            const fit = this.computeImageFit(el, img);
            const fstyle = el.frameStyle || 'none'; // 'none' | 'brush' | 'torn' | 'fade' | 'paint' | 'stamp' | 'frame' | 'brushframe'
            const usePerturbed = (fstyle === 'brush' || fstyle === 'torn');
            // Dekoracyjne ramki (stamp/picture-frame/brush-frame) wymuszają render w bbox prostokąta —
            // owe overlaye są PROSTOKĄTNE i nie pasują do koła/serca/custom; clipFunc nie używa frameShape.
            // Dodatkowo — dla stamp i brushframe — clipFunc tnie do KONTURU RAMKI (perforacje / brush-edges)
            // żeby zdjęcie nie wyzierało w „dziurach" perforacji ani w wyszczerbieniach pędzla.
            const isDecorativeFrame = (fstyle === 'stamp' || fstyle === 'frame' || fstyle === 'brushframe');
            node = new K.Group({
                width: frameW, height: frameH,
                clipFunc: (ctx) => {
                    if (fstyle === 'stamp') {
                        gzStampOutlinePath(ctx, 0, 0, frameW, frameH);
                    } else if (fstyle === 'brushframe') {
                        gzBrushFrameOuterPath(ctx, frameW, frameH, el);
                    } else if (isDecorativeFrame) {
                        gzRoundedRectPath(ctx, 0, 0, frameW, frameH, 0);
                    } else if (usePerturbed) {
                        gzPerturbedShapePath(ctx, fshape, 0, 0, frameW, frameH, el, fstyle);
                    } else if (fshape === 'rect') {
                        gzRoundedRectPath(ctx, 0, 0, frameW, frameH, radius);
                    } else {
                        gzDrawShape(ctx, fshape, 0, 0, frameW, frameH, el);
                    }
                },
            });
            // Nadpisz getClientRect — Konva domyślnie sumuje bbox children (z obrazem WYSTAJĄCYM
            // poza klip). Chcemy, by transformer obejmował tylko widoczną RAMKĘ klipa.
            node.getClientRect = function (cfg) {
                const c = cfg || {};
                if (c.skipTransform) { return { x: 0, y: 0, width: frameW, height: frameH }; }
                const trans = this.getAbsoluteTransform();
                const pts = [
                    trans.point({ x: 0, y: 0 }),
                    trans.point({ x: frameW, y: 0 }),
                    trans.point({ x: 0, y: frameH }),
                    trans.point({ x: frameW, y: frameH }),
                ];
                const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
                return {
                    x: Math.min.apply(null, xs), y: Math.min.apply(null, ys),
                    width: Math.max.apply(null, xs) - Math.min.apply(null, xs),
                    height: Math.max.apply(null, ys) - Math.min.apply(null, ys),
                };
            };
            // Inner image NIE może mieć listening:false — wtedy Group nie łapie kliku.
            node.add(new K.Image({
                image: img, x: fit.x, y: fit.y, width: fit.width, height: fit.height,
            }));
            // STYL „fade" — vignette: overlay z radialnym gradientem alfa, composite destination-out
            // wymywa piksele obrazu od centrum (zachowanie) do krawędzi (kasowanie). Wygląda jak rozjaśnianie.
            if (fstyle === 'fade') {
                const intMul = _gzStyleIntensity(el);
                const cx = frameW / 2, cy = frameH / 2;
                const ms = Math.min(frameW, frameH);
                const rIn  = ms * Math.max(0.05, 0.50 - intMul * 0.15); // przy 100% intens. = 0.20
                const rOut = ms * Math.min(0.95, 0.50 + intMul * 0.13); // przy 100% intens. = 0.76
                node.add(new K.Rect({
                    x: 0, y: 0, width: frameW, height: frameH,
                    fillRadialGradientStartPoint: { x: cx, y: cy },
                    fillRadialGradientStartRadius: rIn,
                    fillRadialGradientEndPoint: { x: cx, y: cy },
                    fillRadialGradientEndRadius: rOut,
                    fillRadialGradientColorStops: [0, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,1)'],
                    globalCompositeOperation: 'destination-out',
                    listening: false,
                }));
            }
            // STYL „paint" — gruby pędzel radialny: maska z pociągnięć od środka do krawędzi,
            // composite destination-in zachowuje obraz tylko POD pociągnięciami (wygląda jak malowane).
            if (fstyle === 'paint') {
                const maskCv = gzPaintedMaskCanvas(frameW, frameH, el);
                node.add(new K.Image({
                    image: maskCv, x: 0, y: 0, width: frameW, height: frameH,
                    globalCompositeOperation: 'destination-in',
                    listening: false,
                }));
            }
            // DEKORACYJNE RAMKI (overlaye rysowane PO obrazie — zasłaniają jego marginesy własną grafiką).
            if (fstyle === 'stamp' || fstyle === 'frame' || fstyle === 'brushframe') {
                const drawFn = (fstyle === 'stamp')   ? gzDrawStampFrameRing
                            :  (fstyle === 'frame')   ? gzDrawPictureFrameRing
                            :                            gzDrawBrushFrameRing;
                node.add(new K.Shape({
                    x: 0, y: 0, width: frameW, height: frameH,
                    listening: false,
                    sceneFunc: (context) => {
                        // K.Shape's Context proxy dziedziczy z natywnego CanvasRenderingContext2D —
                        // przekazujemy `_context` (lub wprost dostęp do natywnych metod via proxy).
                        const ctx = context._context || context;
                        drawFn(ctx, frameW, frameH, el);
                    },
                }));
            }
            // Catcher: niewidoczny rect całej ramki → klikalność marginesów (gdy obraz mniejszy od ramki).
            node.add(new K.Rect({ x: 0, y: 0, width: frameW, height: frameH, fill: '#ffffff', opacity: 0 }));
            // Cień na obrazie z clipFunc Group jest niekompatybilny w Konva (przerywa render całej strony).
            // Realizujemy cień przez DODATKOWY K.Rect-tło ZA grupą — emulacja drop shadow ramki.
            if (el.shadow) {
                // Małe „opóźnienie" — rysujemy shadow-rect jako PIERWSZY child na osobnej Group-wrapper,
                // żeby cień był pod obrazem. Tutaj: dodajemy go do PARENTA przy mount (zob. renderPage).
                node._gzShadow = true;
            }
            } // end of else (el.src present)
        } else if (el.type === 'icon') {
            // Ikony — bez clipa, bez kadrowania (SVG data-URI).
            node = new K.Image({
                width: el.width, height: el.height,
                image: this.getImage(el.src),
            });
            if (el.shadow) {
                node.shadowColor('rgba(0,0,0,0.35)');
                node.shadowBlur(10);
                node.shadowOffset({ x: 0, y: 4 });
            }
        } else if (el.type === 'rect') {
            const cfg = {
                width: el.width, height: el.height,
                stroke: el.stroke || null,
                strokeWidth: el.strokeWidth || 0,
                cornerRadius: el.cornerRadius || 0,
            };
            const g = rectGradientConfig(el);
            if (g) {
                Object.assign(cfg, g); // gradient liniowy/promienisty zamiast solid fill
            } else {
                cfg.fill = el.fill || '#e9eef5';
            }
            node = new K.Rect(cfg);
        } else if (el.type === 'line') {
            node = new K.Line({
                points: [0, 0, el.width, 0],
                stroke: el.stroke || '#1a2330',
                strokeWidth: el.strokeWidth || 2,
                hitStrokeWidth: 12,
                lineCap: 'round',
            });
        } else {
            return null;
        }

        node.id(el.id);
        node.x(el.x);
        node.y(el.y);
        node.rotation(el.rotation || 0);
        node.opacity(el.opacity ?? 1);
        node.draggable(!!interactive);

        if (interactive) {
            node.dragBoundFunc((pos) => this.snapPos(pos, el));
            node.on('mousedown touchstart', (e) => {
                const additive = !!(e.evt && e.evt.shiftKey);
                this.select(el.id, additive);
            });
            node.on('dragstart', () => {
                // Przeciąganie grupy/wielu zaznaczonych razem — zapamiętaj pozycje startowe.
                if (this.selectedIds.length > 1 && this.selectedIds.includes(el.id)) {
                    this._groupDrag = {};
                    this._dragLeader = el.id;
                    for (const id of this.selectedIds) {
                        const n = this.layer.findOne('#' + id);
                        if (n) this._groupDrag[id] = { x: n.x(), y: n.y() };
                    }
                } else {
                    this._groupDrag = null;
                    this._dragLeader = null;
                }
            });
            node.on('dragmove', () => {
                if (!this._groupDrag || !this._groupDrag[el.id]) return;
                const dx = node.x() - this._groupDrag[el.id].x, dy = node.y() - this._groupDrag[el.id].y;
                for (const id of this.selectedIds) {
                    if (id === el.id) continue;
                    const n = this.layer.findOne('#' + id), s = this._groupDrag[id];
                    if (n && s) n.position({ x: s.x + dx, y: s.y + dy });
                }
                this.tr.forceUpdate();
                this.layer.batchDraw();
            });
            node.on('dragend', () => {
                if (this._groupDrag) {
                    for (const id of this.selectedIds) {
                        const n = this.layer.findOne('#' + id), e2 = this.elById(id);
                        if (n && e2) { e2.x = round(n.x()); e2.y = round(n.y()); }
                    }
                    this._groupDrag = null;
                    this._dragLeader = null;
                    this.markDirty();
                    this.renderPage();
                    this.reattachTransformer();
                } else {
                    el.x = round(node.x());
                    el.y = round(node.y());
                    this.markDirty();
                    this.renderPage();      // reflow tekstu oblewającego po przesunięciu (np. obrazka)
                    this.select(el.id);
                }
            });
            if (el.type === 'text') {
                node.on('transform', () => { if (this.selectedIds.length === 1) this.liveReflowText(el, node); });
                node.on('dblclick dbltap', () => this.editText(el, node));
            } else if (el.type === 'image') {
                // dwuklik na obraz: pusta ramka → wybór źródła; obraz wstawiony → picture-box (Quark-style)
                node.on('dblclick dbltap', () => {
                    if (this.hasStatusTarget) { this.statusTarget.textContent = el.src ? 'Picture-box…' : 'Wybór źródła zdjęcia…'; }
                    if (!el.src) { this.openImageSourcePickerFor(el); }
                    else { this.editPictureBox(el, node); }
                });
            }
        }
        return node;
    }

    buildTextGroup(el, showOverflow = true) {
        const group = new this.Konva.Group({ width: el.width, height: el.height });
        this.layoutTextGroup(group, el, showOverflow);
        return group;
    }

    /**
     * (Prze)buduje zawartość ramki tekstu z aktualnego el.width/el.height — używane też przy resize na żywo.
     * showOverflow=false podczas eksportu PDF, żeby znacznik przepełnienia nie trafił na wydruk.
     */
    layoutTextGroup(group, el, showOverflow = true) {
        const K = this.Konva;
        group.destroyChildren();

        // Cień pod wstawką — kładziemy go na pudełku (tło, a gdy go nie ma — obramowanie).
        const shadow = el.shadow
            ? { shadowColor: 'rgba(0,0,0,0.35)', shadowBlur: 10, shadowOffsetX: 0, shadowOffsetY: 4 }
            : {};
        let boxShadowUsed = false;

        // Tło ramki (do robienia kolorowych „wstawek"). Może być jednolite (bgFill) lub gradient (bgGradient*).
        if (el.bgOn && (el.bgFill || el.bgGradientType)) {
            const bgCfg = {
                x: 0, y: 0, width: el.width, height: el.height,
                cornerRadius: Math.max(0, el.bgRadius || 0), listening: false,
                ...shadow,
            };
            const grad = textBgGradientConfig(el);
            if (grad) {
                Object.assign(bgCfg, grad); // linear/radial — bez fill
            } else {
                bgCfg.fill = el.bgFill;
            }
            group.add(new K.Rect(bgCfg));
            boxShadowUsed = el.shadow === true;
        }

        // Obramowanie wstawki (wsunięte o połowę grubości, by mieściło się w ramce).
        if (el.borderOn && (el.borderWidth || 0) > 0) {
            const sw = el.borderWidth;
            group.add(new K.Rect({
                x: sw / 2, y: sw / 2, width: el.width - sw, height: el.height - sw,
                stroke: el.borderColor || '#1a56db', strokeWidth: sw,
                cornerRadius: Math.max(0, el.bgRadius || 0), listening: false,
                ...(el.shadow && !boxShadowUsed ? shadow : {}),
            }));
        }

        // Niewidoczny obszar trafień (pełny rozmiar) — żeby ramkę dało się klikać/przeciągać.
        group.add(new K.Rect({ x: 0, y: 0, width: el.width, height: el.height, fill: '#ffffff', opacity: 0 }));

        // Margines wewnętrzny: tekst układamy w podgrupie przesuniętej o padding, na zmniejszonym obszarze.
        const pad = Math.max(0, el.padding || 0);
        const inner = pad > 0
            ? Object.assign({}, el, { width: Math.max(8, el.width - 2 * pad), height: Math.max(8, el.height - 2 * pad) })
            : el;

        const cols = clamp(inner.columns || 1, 1, 3);
        const lineHpx = (inner.fontSize || 14) * (inner.lineHeight || 1.3);
        const gap = inner.columnGap ?? 14;
        const colW = cols === 1 ? inner.width : (inner.width - gap * (cols - 1)) / cols;
        const align = inner.align || 'left';
        const valign = el.valign || 'top';
        const common = {
            fontSize: inner.fontSize || 14,
            fontFamily: inner.fontFamily || 'Georgia',
            fontStyle: inner.fontStyle || 'normal',
            fill: inner.fill || '#1a2330',
            lineHeight: inner.lineHeight || 1.3,
            listening: false,
        };

        // Oblewanie obrazka: nieobrócona ramka nakładająca się na obraz → własne łamanie ze zmienną szerokością.
        const exclusions = !el.rotation ? this.imageExclusions(el) : [];

        let isOverflow;
        if (exclusions.length) {
            // Przy oblewaniu pionowo zawsze od góry; przesuwamy wykluczenia o padding do układu wewn.
            // Shift dotyczy też metadanych shape-aware (imgX/imgY) — silhouette obrazu w układzie LOKALNYM tekstu.
            const exAdj = pad > 0
                ? exclusions.map((e) => Object.assign({}, e, {
                    x0: e.x0 - pad, x1: e.x1 - pad, y0: e.y0 - pad, y1: e.y1 - pad,
                    imgX: (e.imgX ?? 0) - pad, imgY: (e.imgY ?? 0) - pad,
                }))
                : exclusions;
            const tgroup = new K.Group({ x: pad, y: pad });
            group.add(tgroup);
            isOverflow = this.renderFlowedText(tgroup, inner, exAdj, lineHpx, common, align, cols, colW, gap);
        } else if ((Array.isArray(el.runs) && el.runs.length) || el.list === 'bullet' || el.list === 'number' || this.hasParaAlign(el) || this.hasParaSpacing(el) || this._hyphenator) {
            const tgroup = new K.Group({ x: pad, y: pad });
            group.add(tgroup);
            isOverflow = this.renderRichColumns(tgroup, inner, cols, colW, gap, lineHpx, align, valign, common);
        } else {
            // Zawinięte linie (na szerokość kolumny) + przepływ wg wysokości.
            const lines = this.wrapLines(inner.text || '', colW, common);
            const fit = Math.max(1, Math.floor((inner.height + 1) / lineHpx));
            const balanced = Math.max(1, Math.ceil(lines.length / cols));
            const perCol = Math.min(balanced, fit);
            isOverflow = lines.length > cols * perCol;

            // Wyrównanie w pionie (góra / środek / dół).
            let yOffset = 0;
            const usedLines = cols === 1 ? Math.min(lines.length, fit) : Math.min(perCol, lines.length);
            const contentH = usedLines * lineHpx;
            if (valign === 'middle') yOffset = Math.max(0, (inner.height - contentH) / 2);
            else if (valign === 'bottom') yOffset = Math.max(0, inner.height - contentH);

            const tgroup = new K.Group({ x: pad, y: pad + yOffset });
            group.add(tgroup);

            if (align === 'justify') {
                // Konva.Text nie umie justować — robimy to ręcznie (rozsuwanie słów w linii).
                this.renderJustifiedColumns(tgroup, lines, inner, cols, colW, gap, perCol, lineHpx, common);
            } else if (cols === 1) {
                tgroup.add(new K.Text({
                    x: 0, y: 0, width: inner.width, height: inner.height,
                    text: inner.text || '', align, wrap: 'word', ...common,
                }));
            } else {
                for (let c = 0; c < cols; c++) {
                    const slice = lines.slice(c * perCol, (c + 1) * perCol).join('\n');
                    tgroup.add(new K.Text({
                        x: c * (colW + gap), y: 0, width: colW, height: inner.height,
                        text: slice, align, wrap: 'none', ...common,
                    }));
                }
            }
        }

        // Znacznik przepełnienia: tekst nie mieści się w ramce.
        if (showOverflow && isOverflow) {
            group.add(new K.Rect({
                x: el.width - 14, y: el.height - 14, width: 12, height: 12,
                fill: '#e03131', stroke: '#ffffff', strokeWidth: 1.5, cornerRadius: 2,
                shadowColor: 'rgba(0,0,0,.3)', shadowBlur: 3, listening: false,
                name: 'overflow-marker',
            }));
        }
    }

    /** Justowanie ręczne: każdą linię (poza ostatnią/akapitową/krótką) rozsuwamy słowami do szerokości kolumny. */
    renderJustifiedColumns(group, lines, el, cols, colW, gap, perCol, lineHpx, common) {
        const K = this.Konva;
        const ctx = this.measureCtx();
        ctx.font = this.fontShorthand(el);
        const spaceW = ctx.measureText(' ').width || (el.fontSize || 14) * 0.28;
        const lastIdx = Math.min(lines.length, cols * perCol) - 1;

        for (let c = 0; c < cols; c++) {
            const cx = c * (colW + gap);
            for (let i = 0; i < perCol; i++) {
                const gi = c * perCol + i;
                if (gi >= lines.length) break;

                const words = lines[gi].split(/\s+/).filter(Boolean);
                const y = i * lineHpx;
                if (words.length === 0) continue;

                const ww = words.map((w) => ctx.measureText(w).width);
                const natural = ww.reduce((a, b) => a + b, 0) + spaceW * (words.length - 1);
                // Nie justujemy: ostatniej widocznej linii, linii jednowyrazowych, oraz krótkich (końce akapitów).
                const doJustify = gi !== lastIdx && words.length > 1 && natural >= colW * 0.5;

                if (!doJustify) {
                    group.add(new K.Text({ x: cx, y, width: colW, text: lines[gi], align: 'left', wrap: 'none', ...common }));
                    continue;
                }

                const extra = Math.max(0, (colW - natural) / (words.length - 1));
                let x = 0;
                for (let w = 0; w < words.length; w++) {
                    group.add(new K.Text({ x: cx + x, y, text: words[w], align: 'left', wrap: 'none', ...common }));
                    x += ww[w] + spaceW + extra;
                }
            }
        }
    }

    measureCtx() {
        if (!this._mctx) this._mctx = document.createElement('canvas').getContext('2d');
        return this._mctx;
    }

    fontShorthand(el) {
        const fs = el.fontStyle || 'normal';
        return (fs.includes('italic') ? 'italic ' : '')
            + (fs.includes('bold') ? 'bold ' : '')
            + (el.fontSize || 14) + 'px ' + (el.fontFamily || 'Georgia');
    }

    /** Prostokąty obrazów (w układzie lokalnym ramki tekstu) nakładające się na ramkę — z marginesem.
     *  els domyślnie = bieżąca strona; eksport PDF podaje elementy konkretnej strony. */
    imageExclusions(el, els = this.page().elements) {
        if (el.wrapImages === false) return [];
        const res = [];
        for (const o of els) {
            if (o.rotation || o.id === el.id || o.hidden) continue; // ukryty obraz nie oblewa
            // Zdjęcia oblewają domyślnie; ikony tylko po włączeniu „Oblewaj tekstem".
            const wraps = o.type === 'image' ? (o.wrapText !== false)
                : (o.type === 'icon' ? o.wrapText === true : false);
            if (!wraps) continue;
            // Odstęp oblewania (odpychania tekstu) — cecha obiektu; domyślnie 9 pt.
            const gutter = Math.max(0, o.wrapGap != null ? o.wrapGap : 9);
            const ix1 = o.x + o.width, iy1 = o.y + o.height;
            const tx1 = el.x + el.width, ty1 = el.y + el.height;
            // brak nałożenia?
            if (ix1 <= el.x || o.x >= tx1 || iy1 <= el.y || o.y >= ty1) continue;
            // Obraz, który CAŁKOWICIE zakrywa ramkę tekstu, to tło — nie oblewamy go
            // (inaczej nie ma gdzie zmieścić tekstu i znika, zostaje tylko znacznik przepełnienia).
            if (o.x <= el.x && o.y <= el.y && ix1 >= tx1 && iy1 >= ty1) continue;
            // Kształt ramki obrazu — gdy NIE prostokąt, freeIntervalsInRange policzy x-extent silhouette per wiersz.
            const shape = (o.type === 'image') ? (o.frameShape || 'rect') : 'rect';
            res.push({
                x0: (o.x - el.x) - gutter,
                x1: (ix1 - el.x) + gutter,
                y0: (o.y - el.y) - gutter,
                y1: (iy1 - el.y) + gutter,
                // Metadane do shape-aware extent (układ LOKALNY ramki tekstu):
                shape,
                imgX: o.x - el.x,
                imgY: o.y - el.y,
                imgW: o.width,
                imgH: o.height,
                gutter,
                ref: o, // potrzebne dla customPath
            });
        }
        return res;
    }

    /**
     * WSZYSTKIE wolne przedziały poziome [x0,x1] w wierszu [yTop,yBot] w obrębie [rx0,rx1] po odjęciu obrazów,
     * od lewej do prawej. Dzięki temu tekst może oblewać obraz Z OBU STRON (przedział z lewej i z prawej w tej samej linii).
     * Pomija skrawki węższe niż minW (zbyt wąskie, by ładnie zmieścić tekst). Zwraca [] gdy brak miejsca.
     */
    freeIntervalsInRange(yTop, yBot, rx0, rx1, exclusions, minW) {
        const blocked = [];
        for (const ex of exclusions) {
            if (ex.y0 < yBot && ex.y1 > yTop) {
                let bx0, bx1;
                if (ex.shape && ex.shape !== 'rect') {
                    // Shape-aware: x-extent silhouette w pasie y (układ lokalny obrazu = textY - imgY).
                    // Clamp do bbox obrazu [0, imgH]; gdy band jest CAŁY w gutter-paśmie powyżej/poniżej obrazu,
                    // używamy extentu z najbliższej krawędzi (góra lub dół).
                    let localYTop = yTop - ex.imgY;
                    let localYBot = yBot - ex.imgY;
                    const clampedTop = Math.max(0, Math.min(ex.imgH, localYTop));
                    const clampedBot = Math.max(0, Math.min(ex.imgH, localYBot));
                    let extent;
                    if (clampedBot > clampedTop) {
                        extent = gzShapeExtentInLocalBand(ex.shape, ex.imgW, ex.imgH, ex.ref, clampedTop, clampedBot);
                    } else {
                        // pasek tekstu w pasie gutter — sampluj z najbliższej krawędzi
                        const edgeY = (localYTop >= ex.imgH) ? (ex.imgH - 0.1) : 0.1;
                        extent = gzShapeExtentInLocalBand(ex.shape, ex.imgW, ex.imgH, ex.ref, edgeY, edgeY + 0.2);
                    }
                    if (!extent) { continue; }
                    bx0 = Math.max(rx0, ex.imgX + extent[0] - ex.gutter);
                    bx1 = Math.min(rx1, ex.imgX + extent[1] + ex.gutter);
                } else {
                    bx0 = Math.max(rx0, ex.x0);
                    bx1 = Math.min(rx1, ex.x1);
                }
                if (bx1 > bx0) { blocked.push([bx0, bx1]); }
            }
        }
        if (!blocked.length) return [[rx0, rx1]];

        blocked.sort((a, b) => a[0] - b[0]);
        const free = [];
        let cur = rx0;
        for (const [bx0, bx1] of blocked) {
            if (bx0 - cur >= minW) free.push([cur, bx0]); // wolny pasek przed blokiem (np. z lewej obrazu)
            cur = Math.max(cur, bx1);
        }
        if (rx1 - cur >= minW) free.push([cur, rx1]); // pasek po ostatnim bloku (np. z prawej obrazu)
        return free;
    }

    /**
     * Łamanie tekstu ze zmienną szerokością wiersza, z przepływem przez kolumny (1–3) i oblewaniem obrazów
     * Z OBU STRON (w jednym wierszu wypełniamy kolejno wszystkie wolne paski: z lewej i z prawej obrazu).
     * Zwraca true przy przepełnieniu. Obsługuje formatowanie fragmentów (el.runs).
     */
    renderFlowedText(group, el, exclusions, lineHpx, common, align, cols, colW, gap) {
        const ctx = this.measureCtx();
        ctx.font = this.segFont(el, false, false);
        const spaceW = ctx.measureText(' ').width || (el.fontSize || 14) * 0.28;
        const frameH = el.height;
        const colX = (c) => c * (colW + gap);
        // Pasków węższych niż to nie wypełniamy — za wąskie obok obrazu wyglądałyby źle (tekst poleci tylko po szerszej stronie).
        const minSegW = Math.max(32, (el.fontSize || 14) * 2.2);

        let col = 0;
        let y = 0;
        let overflow = false;

        // Zapewnij wiersz z miejscem w pionie; brak miejsca w kolumnie → następna kolumna.
        const ensureRoom = () => {
            while (y + lineHpx > frameH + 1) {
                col++;
                y = 0;
                if (col >= cols) return false;
            }
            return true;
        };

        const paras = this.richWords(el); // akapity → słowa z segmentami stylu
        for (let p = 0; p < paras.length && !overflow; p++) {
            const words = paras[p];
            const pAlign = this.paraAlignOf(el, p, align);
            if (words.length === 0) {
                if (!ensureRoom()) { overflow = true; break; }
                y += lineHpx; // pusty wiersz / odstęp akapitu
                continue;
            }

            let i = 0;
            while (i < words.length) {
                if (!ensureRoom()) { overflow = true; break; }
                const cx0 = colX(col);
                // Wszystkie wolne paski w tym wierszu (od lewej do prawej) → oblewanie obrazu z obu stron.
                const segs = this.freeIntervalsInRange(y, y + lineHpx, cx0, cx0 + colW, exclusions, minSegW);
                if (!segs.length) { y += lineHpx; continue; } // cały wiersz zasłonięty przez obraz — w dół

                for (let s = 0; s < segs.length && i < words.length; s++) {
                    const seg = segs[s];
                    const availW = seg[1] - seg[0];
                    const fullWidth = availW >= colW - 0.5; // pełna szerokość kolumny (brak obrazu w tym wierszu)
                    const lineWords = [];
                    let w = 0;
                    while (i < words.length) {
                        const wordW = this.measureWord(words[i], el);
                        const add = (lineWords.length ? spaceW : 0) + wordW;
                        if (w + add > availW) {
                            // Spróbuj polskie dzielenie wyrazów PRZED rezygnacją z wpisania słowa.
                            if (lineWords.length > 0) {
                                const splitAvail = availW - w - spaceW;
                                const split = this.trySplitWordToFit(words[i], splitAvail, el);
                                if (split) {
                                    lineWords.push(split.head);
                                    w += spaceW + this.measureWord(split.head, el);
                                    words.splice(i + 1, 0, split.tail);
                                    i++;
                                    break;
                                }
                            }
                            // Pojedyncze słowo szersze niż pasek: wymuś tylko w pełnej szerokości (dłuższe niż kolumna).
                            if (lineWords.length === 0 && fullWidth) { lineWords.push(words[i]); w += add; i++; }
                            break;
                        }
                        lineWords.push(words[i]); w += add; i++;
                    }
                    if (!lineWords.length) continue; // nic nie weszło w ten pasek — spróbuj następnego

                    // Justujemy/zwijamy każdy pasek tak, by „domykał się" do krawędzi obrazu/marginesu, gdy tekst trwa dalej.
                    const moreWords = i < words.length;
                    this.renderRichLine(group, { words: lineWords, lastOfPara: !moreWords }, el, seg[0], y, availW, spaceW, pAlign, !moreWords, common);
                }
                y += lineHpx;
            }
        }
        return overflow;
    }

    // ─── Tekst z formatowaniem fragmentów (bold/italic — el.runs) ───

    /**
     * Rozbija tekst (z el.runs lub el.text) na akapity → słowa → segmenty o jednolitym stylu.
     * Zwraca: [ [ {segs:[{text,bold,italic}]}, … ] , … ] (akapity rozdzielone znakiem nowej linii).
     * Styl bazowy ramki (el.fontStyle) sumuje się z formatowaniem fragmentu (OR).
     */
    richWords(el) {
        const baseB = (el.fontStyle || '').includes('bold');
        const baseI = (el.fontStyle || '').includes('italic');
        const runs = (Array.isArray(el.runs) && el.runs.length) ? el.runs : [{ t: el.text || '' }];

        const paras = [[]];
        let cur = null;
        // _para = indeks akapitu, dla per-akapit letterSpacing
        const pushWord = () => { if (cur) { paras[paras.length - 1].push({ segs: cur, _para: paras.length - 1 }); cur = null; } };

        for (const r of runs) {
            const b = baseB || !!r.b;
            const i = baseI || !!r.i;
            const c = r.c || null;    // kolor segmentu (null = fallback do el.fill)
            const s = r.s || null;    // rozmiar segmentu (null = fallback do el.fontSize)
            for (const ch of String(r.t)) {
                if (ch === '\n') { pushWord(); paras.push([]); continue; }
                if (/\s/.test(ch)) { pushWord(); continue; }
                if (!cur) cur = [];
                const last = cur[cur.length - 1];
                if (last && last.bold === b && last.italic === i && last.color === c && last.size === s) {
                    last.text += ch;
                } else {
                    cur.push({ text: ch, bold: b, italic: i, color: c, size: s });
                }
            }
        }
        pushWord();

        // Lista punktowana / numerowana — prefiks na początku każdego NIEPUSTEGO akapitu.
        // Robione tu (wspólny punkt), więc działa na ekranie i w PDF, w kolumnach i przy oblewaniu.
        if (el.list === 'bullet' || el.list === 'number') {
            let n = 0;
            for (const para of paras) {
                if (!para.length) continue;
                n++;
                const marker = el.list === 'bullet' ? '•' : (n + '.');
                para.unshift({ segs: [{ text: marker, bold: baseB, italic: baseI }] });
            }
        }
        return paras;
    }

    /** Letter-spacing dla danego akapitu: el.paraSpacing[i] albo globalne el.letterSpacing (fallback). */
    letterSpacingFor(el, pIndex) {
        if (Array.isArray(el.paraSpacing) && el.paraSpacing[pIndex] != null) {
            return el.paraSpacing[pIndex];
        }
        return el.letterSpacing || 0;
    }

    hasParaSpacing(el) {
        return Array.isArray(el.paraSpacing) && el.paraSpacing.some((s) => s != null && s !== 0);
    }

    /** Wyrównanie danego akapitu: nadpisanie z el.paraAlign[i] albo wyrównanie ramki (fallback). */
    paraAlignOf(el, pIndex, fallback) {
        const a = el.paraAlign && el.paraAlign[pIndex];
        return a || fallback;
    }

    /** Czy element ma jakiekolwiek wyrównanie ustawione per-akapit? */
    hasParaAlign(el) {
        return Array.isArray(el.paraAlign) && el.paraAlign.some((a) => a);
    }

    /** Rozmiar fontu segmentu (z fallbackiem do el.fontSize). */
    segSize(el, seg) { return (seg && seg.size) ? seg.size : (el.fontSize || 14); }

    /** Kolor fontu segmentu (z fallbackiem do el.fill). */
    segColor(el, seg) { return (seg && seg.color) ? seg.color : (el.fill || '#1a2330'); }

    segFont(el, segOrBold, italic) {
        // Backwards-compat: 2 formy wywołania: (el, segObj) lub (el, bold, italic) — utrzymujemy obie.
        let bold, ital, sz;
        if (segOrBold && typeof segOrBold === 'object') {
            bold = !!segOrBold.bold; ital = !!segOrBold.italic; sz = this.segSize(el, segOrBold);
        } else {
            bold = !!segOrBold; ital = !!italic; sz = (el.fontSize || 14);
        }
        return (ital ? 'italic ' : '') + (bold ? 'bold ' : '') + sz + 'px ' + (el.fontFamily || 'Georgia');
    }

    segStyle(bold, italic) {
        return ((italic ? 'italic ' : '') + (bold ? 'bold' : '')).trim() || 'normal';
    }

    /** Szerokość słowa = suma szerokości segmentów + letter-spacing × (chars-1) per akapit. */
    measureWord(word, el) {
        const ctx = this.measureCtx();
        const ls = this.letterSpacingFor(el, word._para || 0);
        let w = 0, chars = 0;
        for (const s of word.segs) {
            ctx.font = this.segFont(el, s);
            w += ctx.measureText(s.text).width;
            chars += [...s.text].length;
        }
        if (ls && chars > 1) { w += ls * (chars - 1); }
        word._w = w;
        return w;
    }

    /** Maksymalny rozmiar fontu w słowie (do liczenia wysokości linii w wrapie). */
    wordMaxSize(word, el) {
        let m = 0;
        for (const s of word.segs) { const sz = this.segSize(el, s); if (sz > m) m = sz; }
        return m || (el.fontSize || 14);
    }

    /** Rysuje słowo od (x,y_topOfLine): segmenty wyrównane do BASELINE linii.
     *  Każdy segment renderowany od własnego `top = y_topOfLine + baseline - segAscent`,
     *  dzięki czemu różne rozmiary fontów stoją na jednej dolnej linii. */
    renderWord(group, word, el, x, yTop, common, baseline) {
        const K = this.Konva;
        const ctx = this.measureCtx();
        let cx = x;
        const bl = baseline != null ? baseline : ((el.fontSize || 14) * 0.80);
        const ls = this.letterSpacingFor(el, word._para || 0);
        for (const s of word.segs) {
            ctx.font = this.segFont(el, s);
            const sz = this.segSize(el, s);
            const segAscent = sz * 0.80;
            const segTop = yTop + (bl - segAscent);
            const segCommon = { ...common, fontSize: sz, fill: this.segColor(el, s) };
            const segCfg = { x: cx, y: segTop, text: s.text, wrap: 'none', ...segCommon, fontStyle: this.segStyle(s.bold, s.italic) };
            if (ls) { segCfg.letterSpacing = ls; }
            group.add(new K.Text(segCfg));
            const chars = [...s.text].length;
            cx += ctx.measureText(s.text).width + (ls && chars > 0 ? ls * chars : 0);
        }
    }

    /** Łamie słowa na linie szerokości colW. Każda linia ma wyliczone `lineH` i `baseline`
     *  na podstawie MAX rozmiaru segmentu w niej (różne rozmiary = wyższa linia). */
    wrapRichWords(paras, colW, el) {
        const ctx = this.measureCtx();
        ctx.font = this.segFont(el, false, false);
        const spaceW = ctx.measureText(' ').width || (el.fontSize || 14) * 0.28;
        const lh = el.lineHeight || 1.3;
        const baseSize = el.fontSize || 14;
        const lines = [];
        const finalize = (line) => {
            // Wyznacz wysokość linii i baseline z największego segmentu (lub baseSize).
            let maxSize = baseSize;
            for (const w of line.words) {
                for (const s of w.segs) {
                    const sz = this.segSize(el, s);
                    if (sz > maxSize) maxSize = sz;
                }
            }
            line.maxSize = maxSize;
            line.lineH = maxSize * lh;
            line.baseline = maxSize * 0.80; // przybliżony ascent (typowy 0.78–0.82 zależnie od kroju)
            lines.push(line);
        };
        for (let pi = 0; pi < paras.length; pi++) {
            const words = paras[pi];
            if (words.length === 0) { finalize({ words: [], lastOfPara: true, paraIndex: pi }); continue; }
            let line = [], w = 0;
            for (let wi = 0; wi < words.length; wi++) {
                const word = words[wi];
                const wW = this.measureWord(word, el);
                const add = (line.length ? spaceW : 0) + wW;
                if (w + add <= colW) {
                    line.push(word); w += add;
                    continue;
                }
                // Słowo się nie mieści. Spróbuj POLSKIE DZIELENIE.
                if (line.length > 0) {
                    const split = this.trySplitWordToFit(word, colW - w - (line.length ? spaceW : 0), el);
                    if (split) {
                        line.push(split.head); finalize({ words: line, lastOfPara: false, paraIndex: pi });
                        // Kontynuuj od ogona (tail) w następnej linii.
                        words.splice(wi + 1, 0, split.tail);
                        line = []; w = 0;
                        continue;
                    }
                    // Bez dzielenia — całe słowo do nowej linii.
                    finalize({ words: line, lastOfPara: false, paraIndex: pi });
                    line = []; w = 0;
                }
                // W nowej (pustej) linii — sprawdź czy słowo mieści; jeśli nie, podziel mimo wszystko.
                if (wW > colW) {
                    const split = this.trySplitWordToFit(word, colW, el);
                    if (split) {
                        line.push(split.head); finalize({ words: line, lastOfPara: false, paraIndex: pi });
                        words.splice(wi + 1, 0, split.tail);
                        line = []; w = 0;
                        continue;
                    }
                }
                line.push(word); w = wW;
            }
            finalize({ words: line, lastOfPara: true, paraIndex: pi });
        }
        return { lines, spaceW };
    }

    /** Próbuje podzielić słowo tak, by jego HEAD + dywiz zmieściły się w `availW`. */
    trySplitWordToFit(word, availW, el) {
        if (!word || !word.segs || word.segs.length !== 1) { return null; }
        const seg = word.segs[0];
        const text = seg.text || '';
        const parts = this.hyphenateWord(text);
        if (!parts || parts.length < 2) { return null; }
        const ctx = this.measureCtx();
        ctx.font = this.segFont(el, seg);
        let acc = '';
        let cut = -1;
        for (let k = 0; k < parts.length - 1; k++) {
            acc += parts[k];
            const prefixW = ctx.measureText(acc + '-').width;
            if (prefixW <= availW + 0.5) { cut = k + 1; }
            else { break; }
        }
        if (cut <= 0) { return null; }
        const headSeg = { ...seg, text: parts.slice(0, cut).join('') + '-' };
        const tailSeg = { ...seg, text: parts.slice(cut).join('') };
        return { head: { segs: [headSeg] }, tail: { segs: [tailSeg] } };
    }

    /** Renderuje sformatowany tekst w kolumnach (1–3). Każda linia ma WŁASNĄ wysokość (lineH)
     *  zależną od MAX rozmiaru segmentu w niej. Zwraca true przy przepełnieniu. */
    renderRichColumns(group, el, cols, colW, gap, lineHpx, align, valign, common) {
        const { lines, spaceW } = this.wrapRichWords(this.richWords(el), colW, el);
        const colsLines = Array.from({ length: cols }, () => []);
        let colIdx = 0, colH = 0;
        let isOverflow = false;
        for (let li = 0; li < lines.length; li++) {
            const ln = lines[li];
            const lnH = ln.lineH || lineHpx;
            if (colH + lnH > el.height + 1 && colsLines[colIdx].length > 0) {
                colIdx++; colH = 0;
                // Wszystkie kolumny pełne → reszty już się nie zmieści, ale to co już zebraliśmy MUSIMY
                // narysować (kiedyś tu był „return true" → wszystkie linie znikały razem z tekstem).
                if (colIdx >= cols) { isOverflow = true; break; }
            }
            colsLines[colIdx].push(ln);
            colH += lnH;
        }
        // Renderuj kolumna po kolumnie.
        for (let c = 0; c < cols; c++) {
            const cx = c * (colW + gap);
            const colsArr = colsLines[c];
            if (!colsArr.length) { continue; }
            const colContentH = colsArr.reduce((a, l) => a + (l.lineH || lineHpx), 0);
            let yOff = 0;
            if (valign === 'middle') { yOff = Math.max(0, (el.height - colContentH) / 2); }
            else if (valign === 'bottom') { yOff = Math.max(0, el.height - colContentH); }
            let yCur = yOff;
            const lastIdx = colsArr.length - 1;
            for (let i = 0; i < colsArr.length; i++) {
                const ln = colsArr[i];
                const lnH = ln.lineH || lineHpx;
                if (ln.words.length) {
                    this.renderRichLine(group, ln, el, cx, yCur, colW, spaceW,
                        this.paraAlignOf(el, ln.paraIndex, align),
                        (c === cols - 1 && i === lastIdx), common);
                }
                yCur += lnH;
            }
        }
        return isOverflow;
    }

    /** Renderuje jedną linię — segmenty wyrównane do WSPÓLNEJ baseline linii (różne rozmiary OK). */
    renderRichLine(group, line, el, cx, y, colW, spaceW, align, isLastVisible, common) {
        const words = line.words;
        const widths = words.map((w) => (w._w != null ? w._w : this.measureWord(w, el)));
        const natural = widths.reduce((a, b) => a + b, 0) + spaceW * (words.length - 1);
        const baseline = line.baseline || ((el.fontSize || 14) * 0.80);

        if (align === 'justify' && !isLastVisible && !line.lastOfPara && words.length > 1 && natural >= colW * 0.5) {
            const extra = (colW - natural) / (words.length - 1);
            let x = cx;
            for (let k = 0; k < words.length; k++) { this.renderWord(group, words[k], el, x, y, common, baseline); x += widths[k] + spaceW + extra; }
            return;
        }

        let x = cx;
        if (align === 'center') x = cx + (colW - natural) / 2;
        else if (align === 'right') x = cx + (colW - natural);
        for (let k = 0; k < words.length; k++) { this.renderWord(group, words[k], el, x, y, common, baseline); x += widths[k] + spaceW; }
    }

    /** Resize tekstu na żywo: zamienia skalę transformera na realną szerokość i przelewa tekst w trakcie ciągnięcia. */
    liveReflowText(el, node) {
        const w = Math.max(24, Math.round(node.width() * node.scaleX()));
        const h = Math.max(24, Math.round(node.height() * node.scaleY()));
        node.scaleX(1);
        node.scaleY(1);
        node.width(w);
        node.height(h);
        el.width = w;
        el.height = h;
        this.layoutTextGroup(node, el, true);
        this.layer.batchDraw();
    }

    /** Zwraca tablicę linii po zawinięciu tekstu w danej szerokości (wykorzystuje wewn. mechanizm Konvy). */
    wrapLines(text, width, common) {
        const measure = new this.Konva.Text({ text, width, wrap: 'word', ...common });
        const arr = measure.textArr;
        const lines = Array.isArray(arr) && arr.length
            ? arr.map((l) => l.text)
            : String(text).split('\n');
        measure.destroy();
        return lines;
    }

    getImage(src) {
        if (this.imageCache[src]) return this.imageCache[src];
        const img = new window.Image();
        img.onload = () => { this.layer.batchDraw(); this.renderThumbs(); };
        img.src = src;
        this.imageCache[src] = img;
        return img;
    }

    /** Wymusza załadowanie WSZYSTKICH fontów używanych w dokumencie (Google Fonts ładują lazy —
     *  font użyty tylko na nieaktywnej stronie może nie być wczytany; canvas measureText
     *  liczy wtedy szerokość fallbackiem → niepoprawny layout w rasterze PDF). */
    async preloadAllFonts() {
        if (!document.fonts) { return; }
        const fams = new Set();
        for (const p of this.doc.pages) {
            for (const el of p.elements) {
                if (el.type === 'text' && el.fontFamily) { fams.add(el.fontFamily); }
            }
        }
        const styles = [
            ['', 400], ['', 700],
            ['italic ', 400], ['italic ', 700],
        ];
        const tasks = [];
        for (const f of fams) {
            for (const [st, wg] of styles) {
                tasks.push(document.fonts.load(`${st}${wg} 16px "${f}"`).catch(() => {}));
            }
        }
        await Promise.all(tasks);
        try { await document.fonts.ready; } catch (_) { /* ignore */ }
    }

    /** Czeka aż wszystkie obrazy dokumentu się załadują (potrzebne przed eksportem). */
    async preloadAllImages() {
        const srcs = new Set();
        for (const p of this.doc.pages) {
            for (const el of p.elements) if ((el.type === 'image' || el.type === 'icon') && el.src) srcs.add(el.src);
        }
        await Promise.all([...srcs].map((src) => new Promise((resolve) => {
            const cached = this.imageCache[src];
            if (cached && cached.complete && cached.naturalWidth) return resolve();
            const img = new window.Image();
            img.onload = () => { this.imageCache[src] = img; resolve(); };
            img.onerror = () => resolve();
            img.src = src;
        })));
    }

    // ─── Selekcja + transform ───────────────────────────────

    /** Zaznacza element. additive (Shift) = dołącz/odłącz jednostkę; klik w element grupy = cała grupa. */
    select(id, additive = false) {
        if (id == null) {
            this.selectedIds = [];
        } else if (additive) {
            const unit = this.unitIds(id);                       // grupa → wszyscy członkowie, inaczej [id]
            const allIn = unit.every((u) => this.selectedIds.includes(u));
            this.selectedIds = allIn
                ? this.selectedIds.filter((s) => !unit.includes(s))
                : Array.from(new Set([...this.selectedIds, ...unit]));
        } else if (this.selectedIds.length > 1 && this.selectedIds.includes(id)) {
            // Klik w element istniejącej selekcji wielokrotnej — zachowaj ją (by dało się przeciągać całość).
        } else {
            this.selectedIds = this.unitIds(id);
        }
        this.selectedId = this.selectedIds.length === 1 ? this.selectedIds[0] : null;
        this.reattachTransformer();
        this.syncProps();
        this.renderLayersSelection();
    }

    /** Jednostka selekcji dla elementu: wszyscy członkowie jego grupy albo on sam. */
    unitIds(id) {
        const el = this.elById(id);
        if (el && el.groupId) return this.page().elements.filter((e) => e.groupId === el.groupId).map((e) => e.id);
        return [id];
    }

    elById(id) {
        return this.page().elements.find((e) => e.id === id) || null;
    }

    selectedEl() {
        return this.selectedId ? this.elById(this.selectedId) : null;
    }

    /** Elementy bieżącej selekcji (w kolejności z dokumentu). */
    selectedElements() {
        return this.page().elements.filter((e) => this.selectedIds.includes(e.id));
    }

    /** Rozszerza listę id o wszystkich współtowarzyszy grupy. */
    expandGroups(ids) {
        const out = new Set();
        for (const id of ids) for (const u of this.unitIds(id)) out.add(u);
        return Array.from(out);
    }

    elIntersectsRect(el, rx0, ry0, rx1, ry1) {
        const ex1 = el.x + (el.width || 0), ey1 = el.y + (el.height || 1);
        return !(ex1 < rx0 || el.x > rx1 || ey1 < ry0 || el.y > ry1);
    }

    /** Zapisuje transformację WSZYSTKICH zaznaczonych węzłów (skala→rozmiar, pozycja, obrót). */
    commitTransform() {
        for (const id of this.selectedIds) {
            const node = this.layer.findOne('#' + id);
            const el = this.elById(id);
            if (!node || !el) continue;
            const sx = node.scaleX(), sy = node.scaleY();
            el.x = round(node.x());
            el.y = round(node.y());
            el.rotation = round(node.rotation());
            if (el.type === 'line') {
                el.width = Math.max(4, round(el.width * sx));
            } else {
                el.width = Math.max(12, round(el.width * sx));
                el.height = Math.max(12, round(el.height * sy));
            }
            // Obrazy: zachowaj proporcjonalne położenie i rozmiar zdjęcia w ramce (content+frame scaling).
            if (el.type === 'image' && el.fit) {
                el.fit = {
                    x: el.fit.x * sx, y: el.fit.y * sy,
                    width: el.fit.width * sx, height: el.fit.height * sy,
                };
            }
            node.scale({ x: 1, y: 1 });
        }
        this.markDirty();
        this.renderPage();
        this.reattachTransformer();
    }

    // ─── Edycja tekstu (contenteditable + pasek B/I) ───────────

    editText(el, node) {
        const box = node.getClientRect({ relativeTo: this.stage });
        const stageBox = this.stage.container().getBoundingClientRect();
        const z = this.zoom;

        node.hide();
        this.tr.nodes([]);
        this.layer.draw();
        try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* starsze przeglądarki */ }

        const cap = Math.round(window.innerHeight * 0.6);
        const left = stageBox.left + window.scrollX + box.x * z;
        const top = stageBox.top + window.scrollY + box.y * z;

        // Szpalty + padding zgodne z renderem ramki (1–3 kolumny + odstęp, jak na canvasie).
        const cols = Math.max(1, Math.min(3, el.columns || 1));
        const colGapPx = Math.max(0, (el.columnGap ?? 14)) * z;
        const padPx = Math.max(0, el.padding || 0) * z;
        const fieldW = Math.max(80, box.width * z);
        const fieldH = Math.max(40, box.height * z);

        // ── Oblewanie tekstu obrazami ──
        // 1 szpalta: prawdziwe oblewanie przez „blokery" (float + shape-outside).
        // ≥2 szpalty: CSS column-count + float NIE pozwala wskazać, do której szpalty trafia float
        //             (zawsze idzie do tej, w której pojawia się w source order → 1. szpalta).
        //             Zamiast tego renderujemy POZA contenteditable wizualne markery „dziur"
        //             pokazujące, gdzie obrazek wejdzie. Tekst w polu edycji ich nie oplata,
        //             ale na canvasie po zapisie oblewanie zadziała poprawnie.
        const allExclusions = (!el.rotation) ? this.imageExclusions(el) : [];
        const wrapExclusions = (cols === 1) ? allExclusions : [];
        const overlayExclusions = (cols > 1) ? allExclusions : [];
        let wrapHTML = '';
        if (wrapExclusions.length) {
            const innerW = el.width - 2 * (el.padding || 0);
            const sortedEx = wrapExclusions.slice().sort((a, b) => a.y0 - b.y0);
            let prevBottom = 0;                  // dolna krawędź ostatniego blokera (w układzie wewn., bez paddingu)
            for (const ex of sortedEx) {
                const ix0 = ex.x0 - (el.padding || 0);
                const ix1 = ex.x1 - (el.padding || 0);
                const iy0 = ex.y0 - (el.padding || 0);
                const iy1 = ex.y1 - (el.padding || 0);
                if (ix1 <= 0 || ix0 >= innerW || iy1 <= 0) continue;
                const w = Math.max(1, ix1 - ix0) * z;
                const h = Math.max(1, iy1 - iy0) * z;
                const cx = (ix0 + ix1) / 2;
                const side = cx < innerW / 2 ? 'left' : 'right';     // strona „wciągania" obrazu
                const marginTop = Math.max(0, (iy0 - prevBottom)) * z;
                let shapeCSS = 'inset(0)';                            // domyślnie prostokąt
                if (ex.shape === 'circle') { shapeCSS = 'circle(50% at 50% 50%)'; }
                else if (ex.shape === 'ellipse') { shapeCSS = 'ellipse(50% 50% at 50% 50%)'; }
                wrapHTML += '<div contenteditable="false" data-gz-wrap="1" aria-hidden="true" style="'
                    + 'float:' + side + ';clear:' + side + ';'
                    + 'width:' + w + 'px;height:' + h + 'px;'
                    + 'margin-top:' + marginTop + 'px;'
                    + 'shape-outside:' + shapeCSS + ';shape-margin:0;'
                    + 'user-select:none;pointer-events:none;'
                    + '"></div>';
                prevBottom = iy1;
            }
        }

        // Edytowalne pole z formatowaniem fragmentów (bold/italic).
        const ed = document.createElement('div');
        ed.contentEditable = 'true';
        ed.spellcheck = false;
        ed.lang = 'pl';                          // wymagane przez CSS hyphens (przeglądarka wybiera słownik)
        ed.innerHTML = wrapHTML + this.htmlFromRuns(el, z);
        document.body.appendChild(ed);
        Object.assign(ed.style, {
            position: 'absolute',
            left: left + 'px',
            top: top + 'px',
            width: fieldW + 'px',
            // Dla 1 szpalty pozwalamy rosnąć (komfort edycji); dla >1 szpalty trzymamy wysokość ramki,
            // żeby tekst dzielił się na N kolumn dokładnie tak, jak na canvasie.
            ...(cols > 1
                ? { height: fieldH + 'px', maxHeight: fieldH + 'px' }
                : { minHeight: fieldH + 'px', maxHeight: cap + 'px' }),
            fontSize: (el.fontSize || 14) * z + 'px',
            fontFamily: el.fontFamily || 'Georgia',
            lineHeight: el.lineHeight || 1.3,
            color: el.fill || '#1a2330',
            textAlign: el.align === 'justify' ? 'justify' : (el.align || 'left'),
            padding: padPx ? padPx + 'px' : '2px 4px',
            margin: '0', border: '2px solid #1a56db', borderRadius: '3px',
            background: '#fff', outline: 'none', whiteSpace: 'pre-wrap', wordWrap: 'break-word',
            zIndex: 2000, overflowY: 'auto', boxSizing: 'border-box',
            boxShadow: '0 6px 18px rgba(0,0,0,.18)',
            hyphens: 'auto', webkitHyphens: 'auto', mozHyphens: 'auto', msHyphens: 'auto',
            letterSpacing: el.letterSpacing ? (el.letterSpacing * z) + 'px' : 'normal',
            ...(cols > 1
                ? {
                    columnCount: String(cols),
                    columnGap: colGapPx + 'px',
                    columnFill: 'auto',           // wypełnia kolumny po kolei, nie balansuje
                }
                : {}),
        });

        // ── Wizualne markery „dziur" pod obrazy (gdy ≥2 szpalty — brak prawdziwego oblewania w CSS) ──
        // Półprzezroczyste prostokąty/koła/owale w miejscach, gdzie obrazek nakłada się na ramkę.
        // NIE łamią tekstu w polu edycji (CSS nie pozwala), ale pokazują, gdzie wejdą obrazy.
        // Po zapisie canvas zastosuje oblewanie zgodnie z `imageExclusions`.
        let overlay = null;
        if (overlayExclusions.length) {
            overlay = document.createElement('div');
            Object.assign(overlay.style, {
                position: 'absolute',
                left: (left + padPx) + 'px', top: (top + padPx) + 'px',
                width: Math.max(0, fieldW - 2 * padPx) + 'px',
                height: Math.max(0, fieldH - 2 * padPx) + 'px',
                pointerEvents: 'none', zIndex: 2000, overflow: 'hidden', boxSizing: 'border-box',
            });
            const innerW = el.width - 2 * (el.padding || 0);
            const innerH = el.height - 2 * (el.padding || 0);
            for (const ex of overlayExclusions) {
                const ix0 = ex.x0 - (el.padding || 0);
                const ix1 = ex.x1 - (el.padding || 0);
                const iy0 = ex.y0 - (el.padding || 0);
                const iy1 = ex.y1 - (el.padding || 0);
                if (ix1 <= 0 || ix0 >= innerW || iy1 <= 0 || iy0 >= innerH) continue;
                const cx0 = Math.max(0, ix0) * z;
                const cy0 = Math.max(0, iy0) * z;
                const cw = (Math.min(innerW, ix1) - Math.max(0, ix0)) * z;
                const ch = (Math.min(innerH, iy1) - Math.max(0, iy0)) * z;
                let radius = '0';
                if (ex.shape === 'circle' || ex.shape === 'ellipse') { radius = '50%'; }
                const marker = document.createElement('div');
                Object.assign(marker.style, {
                    position: 'absolute', left: cx0 + 'px', top: cy0 + 'px',
                    width: cw + 'px', height: ch + 'px',
                    border: '1.5px dashed rgba(232,110,30,.7)',
                    background: 'rgba(252,211,154,.22)',
                    borderRadius: radius, boxSizing: 'border-box',
                });
                overlay.appendChild(marker);
            }
            document.body.appendChild(overlay);
        }

        // ── Redagowanie z AI (działa na zaznaczonym fragmencie) ──
        let aiOpen = false;     // gdy panel otwarty — blur NIE zatwierdza edycji
        let aiPanel = null;
        let savedRange = null;  // zaznaczenie zapamiętane w chwili kliknięcia „AI"

        // Zastępuje treść zakresu czystym tekstem (\n → <br>) i zwraca zakres obejmujący wstawione węzły.
        const replaceRangeWithText = (range, text) => {
            range.deleteContents();
            const frag = document.createDocumentFragment();
            const nodes = [];
            String(text).split('\n').forEach((part, i) => {
                if (i) { const br = document.createElement('br'); frag.appendChild(br); nodes.push(br); }
                const tn = document.createTextNode(part); frag.appendChild(tn); nodes.push(tn);
            });
            range.insertNode(frag);
            const nr = document.createRange();
            if (nodes.length) { nr.setStartBefore(nodes[0]); nr.setEndAfter(nodes[nodes.length - 1]); }
            else { nr.selectNodeContents(ed); nr.collapse(false); }
            return nr;
        };
        const restoreSelection = () => {
            if (!savedRange) return;
            ed.focus();
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(savedRange);
        };

        const closeAiPanel = (commitNow) => {
            if (aiPanel) { aiPanel.remove(); aiPanel = null; }
            aiOpen = false;
            if (commitNow) commit();
            else restoreSelection();
        };

        const openAiPanel = () => {
            if (aiPanel) return;
            aiOpen = true;

            const PANEL_W = 232;
            aiPanel = document.createElement('div');
            Object.assign(aiPanel.style, {
                position: 'absolute', width: PANEL_W + 'px',
                background: '#1a2330', color: '#fff', borderRadius: '8px',
                padding: '9px', zIndex: 2002, boxShadow: '0 10px 28px rgba(0,0,0,.35)',
                fontFamily: 'system-ui, sans-serif', fontSize: '12px',
            });
            // Pozycja: z PRAWEJ strony ramki; gdy brak miejsca → z lewej; ostatecznie pod ramką.
            const place = () => {
                const r = ed.getBoundingClientRect();
                let left = r.right + 8;
                let top = r.top;
                if (left + PANEL_W > window.innerWidth - 6) {
                    const leftSide = r.left - PANEL_W - 8;
                    if (leftSide >= 6) left = leftSide;
                    else { left = Math.min(r.left, window.innerWidth - PANEL_W - 6); top = r.bottom + 6; }
                }
                aiPanel.style.left = (window.scrollX + Math.max(6, left)) + 'px';
                aiPanel.style.top = (window.scrollY + Math.max(6, top)) + 'px';
            };

            const head = document.createElement('div');
            head.innerHTML = '<span style="font-weight:600;font-size:12.5px"><span style="opacity:.85">✨ </span>Redaguj z AI</span>';
            Object.assign(head.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '7px' });
            const closeX = document.createElement('button');
            closeX.type = 'button'; closeX.textContent = '✕';
            Object.assign(closeX.style, { background: 'transparent', border: 'none', color: '#9aa7bd', cursor: 'pointer', fontSize: '14px', lineHeight: '1' });
            closeX.addEventListener('mousedown', (e) => { e.preventDefault(); closeAiPanel(false); });
            head.appendChild(closeX);
            aiPanel.appendChild(head);

            const status = document.createElement('div');
            Object.assign(status.style, { fontSize: '11px', minHeight: '15px', margin: '0 0 7px', color: '#9aa7bd' });
            const fragLen = (savedRange.toString() || '').trim().length;
            status.textContent = fragLen
                ? ('Zaznaczono ' + fragLen + ' znaków.')
                : 'Brak zaznaczenia — zadziała na całym tekście.';
            const setStatus = (msg, err) => { status.textContent = msg || ''; status.style.color = err ? '#ff9a9a' : '#9aa7bd'; };

            // ── Sterowanie (presety + własne polecenie) ──
            const controls = document.createElement('div');

            const grid = document.createElement('div');
            Object.assign(grid.style, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '6px' });
            const presets = [
                ['rephrase', 'Przeredaguj'],
                ['fix', 'Popraw język'],
                ['shorten', 'Skróć'],
                ['expand', 'Rozwiń'],
                ['simplify', 'Uprość'],
                ['formal', 'Oficjalny ton'],
            ];

            const setBusy = (busy) => {
                Array.from(aiPanel.querySelectorAll('button')).forEach((b) => { if (b !== closeX) b.disabled = busy; });
            };

            // Po odpowiedzi AI — pokaż porównanie stary ↔ nowy z akceptacją.
            const showCompare = (oldText, newText) => {
                controls.style.display = 'none';
                oldBox.textContent = oldText;
                newArea.value = newText;
                compare.style.display = '';
                setStatus('Sprawdź zmianę i zaakceptuj lub odrzuć.');
            };
            const hideCompare = () => { compare.style.display = 'none'; controls.style.display = ''; };

            const runAction = async (action, instruction) => {
                const fragment = savedRange.toString();
                if (!fragment.trim()) { setStatus('Najpierw zaznacz fragment tekstu.', true); return; }
                setBusy(true);
                setStatus('AI redaguje…');
                try {
                    const out = await this.aiRedact(action, instruction || '', fragment, el.text || '');
                    showCompare(fragment, out);
                } catch (e) {
                    setStatus('Błąd: ' + (e.message || e), true);
                } finally {
                    setBusy(false);
                }
            };

            for (const [action, label] of presets) {
                const b = document.createElement('button');
                b.type = 'button'; b.textContent = label;
                Object.assign(b.style, {
                    border: 'none', borderRadius: '6px', background: '#2b3954', color: '#fff',
                    padding: '6px 5px', cursor: 'pointer', fontSize: '11.5px',
                });
                b.addEventListener('mouseenter', () => { if (!b.disabled) b.style.background = '#37496b'; });
                b.addEventListener('mouseleave', () => { b.style.background = '#2b3954'; });
                b.addEventListener('mousedown', (e) => { e.preventDefault(); runAction(action); });
                grid.appendChild(b);
            }
            controls.appendChild(grid);

            const row = document.createElement('div');
            Object.assign(row.style, { display: 'flex', gap: '5px' });
            const inp = document.createElement('input');
            inp.type = 'text'; inp.placeholder = 'Własne polecenie…';
            Object.assign(inp.style, {
                flex: '1', minWidth: '0', border: '1px solid #38466a', borderRadius: '6px',
                background: '#0f1726', color: '#fff', padding: '6px 7px', fontSize: '11.5px', outline: 'none',
            });
            inp.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') { e.preventDefault(); runAction('custom', inp.value); }
                else if (e.key === 'Escape') { e.preventDefault(); closeAiPanel(false); }
            });
            const send = document.createElement('button');
            send.type = 'button'; send.textContent = '➜';
            send.title = 'Wyślij własne polecenie';
            Object.assign(send.style, { border: 'none', borderRadius: '6px', background: '#4263eb', color: '#fff', padding: '6px 10px', cursor: 'pointer', fontSize: '12px' });
            send.addEventListener('mousedown', (e) => { e.preventDefault(); runAction('custom', inp.value); });
            row.appendChild(inp); row.appendChild(send);
            controls.appendChild(row);
            aiPanel.appendChild(controls);

            // ── Porównanie stary ↔ nowy (ukryte do czasu odpowiedzi) ──
            const compare = document.createElement('div');
            compare.style.display = 'none';
            const lbl = (t) => { const d = document.createElement('div'); d.textContent = t; Object.assign(d.style, { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.04em', color: '#7e8aa3', margin: '0 0 3px' }); return d; };
            const boxStyle = { maxHeight: '92px', overflowY: 'auto', borderRadius: '6px', padding: '6px 7px', fontSize: '11.5px', lineHeight: '1.35', whiteSpace: 'pre-wrap', wordWrap: 'break-word' };

            compare.appendChild(lbl('Stary tekst'));
            const oldBox = document.createElement('div');
            Object.assign(oldBox.style, { ...boxStyle, background: '#241a1f', color: '#e6b3b3', border: '1px solid #5a2f38', marginBottom: '6px' });
            compare.appendChild(oldBox);

            compare.appendChild(lbl('Nowy tekst'));
            const newArea = document.createElement('textarea');
            newArea.rows = 4;
            Object.assign(newArea.style, { ...boxStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', background: '#16241b', color: '#a8e6b8', border: '1px solid #2f5a3a', outline: 'none', fontFamily: 'inherit', marginBottom: '7px' });
            newArea.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); hideCompare(); setStatus('Odrzucono.'); } });
            compare.appendChild(newArea);

            const cmpBtns = document.createElement('div');
            Object.assign(cmpBtns.style, { display: 'flex', gap: '6px' });
            const acceptBtn = document.createElement('button');
            acceptBtn.type = 'button'; acceptBtn.textContent = '✓ Akceptuj';
            Object.assign(acceptBtn.style, { flex: '1', border: 'none', borderRadius: '6px', background: '#2f9e44', color: '#fff', padding: '7px', cursor: 'pointer', fontSize: '12px', fontWeight: '600' });
            acceptBtn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                restoreSelection();
                savedRange = replaceRangeWithText(savedRange, newArea.value);
                restoreSelection();
                hideCompare();
                setStatus('Zastosowano. Możesz redagować dalej.');
            });
            const rejectBtn = document.createElement('button');
            rejectBtn.type = 'button'; rejectBtn.textContent = '✕ Odrzuć';
            Object.assign(rejectBtn.style, { flex: '1', border: 'none', borderRadius: '6px', background: '#2b3954', color: '#fff', padding: '7px', cursor: 'pointer', fontSize: '12px' });
            rejectBtn.addEventListener('mousedown', (e) => { e.preventDefault(); hideCompare(); setStatus('Odrzucono.'); });
            cmpBtns.appendChild(acceptBtn); cmpBtns.appendChild(rejectBtn);
            compare.appendChild(cmpBtns);
            aiPanel.appendChild(compare);

            aiPanel.appendChild(status);

            const foot = document.createElement('div');
            Object.assign(foot.style, { display: 'flex', justifyContent: 'flex-end', marginTop: '6px' });
            const doneBtn = document.createElement('button');
            doneBtn.type = 'button'; doneBtn.textContent = 'Gotowe';
            Object.assign(doneBtn.style, { border: 'none', borderRadius: '6px', background: '#2b3954', color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: '11.5px' });
            doneBtn.addEventListener('mousedown', (e) => { e.preventDefault(); closeAiPanel(false); });
            foot.appendChild(doneBtn);
            aiPanel.appendChild(foot);

            document.body.appendChild(aiPanel);
            place();
        };

        // Pasek formatowania nad polem (B/I/kolor/rozmiar/wyrównanie/odstęp/AI).
        // Lekki, biały styl spójny z resztą edytora; Tabler Icons; grupowanie separatorami.
        const bar = document.createElement('div');
        Object.assign(bar.style, {
            position: 'absolute', left: left + 'px', top: Math.max(0, top - 44) + 'px',
            display: 'flex', alignItems: 'center', gap: '1px', padding: '4px 5px',
            background: '#ffffff', border: '1px solid #e3e6ea', borderRadius: '9px',
            boxShadow: '0 8px 22px rgba(15,24,40,.14), 0 1px 2px rgba(15,24,40,.06)',
            zIndex: 2001, fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            color: '#2a3247', userSelect: 'none',
        });

        // ── Helpery: spójny przycisk i separator ──
        const baseBtn = () => {
            const b = document.createElement('button');
            b.type = 'button';
            Object.assign(b.style, {
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: '30px', height: '30px', border: 'none', background: 'transparent',
                color: '#2a3247', cursor: 'pointer', borderRadius: '6px',
                fontSize: '16px', lineHeight: '1', padding: '0',
                transition: 'background-color .12s ease, color .12s ease',
            });
            b.addEventListener('mouseenter', () => { if (b.dataset.active !== '1') b.style.background = '#eef0f4'; });
            b.addEventListener('mouseleave', () => { if (b.dataset.active !== '1') b.style.background = 'transparent'; });
            return b;
        };
        const setActive = (b, on) => {
            if (!b) { return; }
            if (on) {
                b.dataset.active = '1';
                b.style.background = '#ede9fe';
                b.style.color = '#5b21b6';
            } else {
                b.dataset.active = '';
                b.style.background = 'transparent';
                b.style.color = '#2a3247';
            }
        };
        const mkSep = () => {
            const s = document.createElement('span');
            Object.assign(s.style, { width: '1px', height: '20px', background: '#e3e6ea', margin: '0 4px', flexShrink: '0' });
            return s;
        };

        // ── B / I (toggle z aktywnym stanem wg queryCommandState) ──
        const mkFmtBtn = (icon, cmd, title) => {
            const b = baseBtn();
            b.innerHTML = '<i class="ti ti-' + icon + '"></i>';
            b.title = title;
            b.addEventListener('mousedown', (e) => {
                e.preventDefault();
                document.execCommand(cmd, false, null);
                ed.focus();
                try { setActive(b, document.queryCommandState(cmd)); } catch (_) { /* OK */ }
            });
            return b;
        };
        const boldBtn = mkFmtBtn('bold', 'bold', 'Pogrubienie (Ctrl+B)');
        const italBtn = mkFmtBtn('italic', 'italic', 'Kursywa (Ctrl+I)');
        bar.appendChild(boldBtn);
        bar.appendChild(italBtn);

        // Flaga: trwa operacja formatowania (paleta koloru / select rozmiaru) — blur NIE zamyka edycji.
        let formatActive = false;
        let savedSelRange = null;
        const captureSelection = () => {
            const sel = window.getSelection();
            savedSelRange = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : null;
        };
        const restoreSel = () => {
            if (!savedSelRange) { return; }
            ed.focus();
            const sel = window.getSelection();
            sel.removeAllRanges(); sel.addRange(savedSelRange);
        };
        const endFormatting = () => {
            // Krótka zwłoka: pozwalamy natywnemu dialogowi/zwinięciu select-a najpierw oddać focus,
            // potem cofamy się do contenteditable i kasujemy flagę.
            setTimeout(() => { formatActive = false; restoreSel(); }, 0);
        };

        bar.appendChild(mkSep());

        // ── Kolor zaznaczonego tekstu: przycisk „A" z kolorowym paskiem pod spodem (input[color] schowany pod spodem) ──
        const colorWrap = document.createElement('label');
        colorWrap.title = 'Kolor zaznaczonego tekstu';
        Object.assign(colorWrap.style, {
            position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '30px', height: '30px', borderRadius: '6px', cursor: 'pointer',
            color: '#2a3247', transition: 'background-color .12s ease', overflow: 'hidden',
        });
        colorWrap.addEventListener('mouseenter', () => { colorWrap.style.background = '#eef0f4'; });
        colorWrap.addEventListener('mouseleave', () => { colorWrap.style.background = 'transparent'; });
        const colorALetter = document.createElement('span');
        colorALetter.textContent = 'A';
        Object.assign(colorALetter.style, { fontSize: '15px', fontWeight: '700', lineHeight: '1', marginTop: '-2px', pointerEvents: 'none' });
        colorWrap.appendChild(colorALetter);
        const colorUnder = document.createElement('span');
        Object.assign(colorUnder.style, {
            position: 'absolute', left: '7px', right: '7px', bottom: '6px',
            height: '4px', borderRadius: '2px', background: (el.fill || '#1a2330'),
            pointerEvents: 'none', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.06)',
        });
        colorWrap.appendChild(colorUnder);
        const colorBtn = document.createElement('input');
        colorBtn.type = 'color';
        colorBtn.value = el.fill || '#1a2330';
        Object.assign(colorBtn.style, { position: 'absolute', inset: '0', opacity: '0', cursor: 'pointer', border: 'none', padding: '0', margin: '0' });
        colorWrap.appendChild(colorBtn);
        colorBtn.addEventListener('mousedown', () => { formatActive = true; captureSelection(); });
        // 'change' = user zatwierdził kolor (zamknął dialog) — wtedy ręcznie owijam zaznaczenie w span.
        // (NIE używam execCommand('foreColor') — w nowoczesnym Chrome generuje niespójny HTML,
        //  którego parser nie zawsze łapie → kolor znika po reentry).
        colorBtn.addEventListener('change', () => {
            colorUnder.style.background = colorBtn.value;
            restoreSel();
            const sel = window.getSelection();
            if (sel && sel.rangeCount && !sel.isCollapsed) {
                const span = wrapRangeWithStyle(sel.getRangeAt(0), 'color', colorBtn.value);
                if (span) {
                    const nr = document.createRange();
                    nr.selectNodeContents(span);
                    sel.removeAllRanges(); sel.addRange(nr);
                    savedSelRange = nr.cloneRange();
                }
            }
            endFormatting();
        });
        bar.appendChild(colorWrap);

        // ── Helper: wrap zaznaczenia spanem z danym stylem, czyszcząc tę samą właściwość z dzieci ──
        // (Dzięki temu wybranie rozmiaru/koloru na fragmencie o RÓŻNYCH rozmiarach/kolorach faktycznie
        //  nadpisuje wszystko — inaczej wewnętrzne spany utrzymywałyby swoje wartości przez CSS cascade.)
        function wrapRangeWithStyle(range, prop, value) {
            try {
                const frag = range.extractContents();
                frag.querySelectorAll('[style]').forEach((elx) => {
                    elx.style[prop] = '';
                    if (!elx.getAttribute('style')) { elx.removeAttribute('style'); }
                });
                const span = document.createElement('span');
                span.style[prop] = value;
                span.appendChild(frag);
                range.insertNode(span);
                return span;
            } catch (_) {
                try {
                    const span2 = document.createElement('span');
                    span2.style[prop] = value;
                    range.surroundContents(span2);
                    return span2;
                } catch (__) { return null; }
            }
        }

        // ── Rozmiar fontu ZAZNACZONEGO tekstu (ikona „rozmiar" + select) ──
        const sizeWrap = document.createElement('div');
        Object.assign(sizeWrap.style, { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '0 4px 0 6px' });
        const sizeIcon = document.createElement('i');
        sizeIcon.className = 'ti ti-text-size';
        Object.assign(sizeIcon.style, { fontSize: '15px', color: '#6c7793' });
        sizeWrap.appendChild(sizeIcon);
        const sizeSel = document.createElement('select');
        sizeSel.title = 'Rozmiar zaznaczonego tekstu (pt)';
        Object.assign(sizeSel.style, {
            height: '26px', minWidth: '58px', background: '#fff', color: '#2a3247',
            border: '1px solid #d8dde5', borderRadius: '5px', padding: '0 4px',
            cursor: 'pointer', fontSize: '12px', outline: 'none',
        });
        const defaultOpt = document.createElement('option');
        defaultOpt.value = ''; defaultOpt.textContent = 'rozm.';
        sizeSel.appendChild(defaultOpt);
        [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 36, 42, 48, 56, 64, 72].forEach((sz) => {
            const o = document.createElement('option'); o.value = String(sz); o.textContent = sz + ' pt';
            sizeSel.appendChild(o);
        });
        sizeSel.addEventListener('mousedown', () => { formatActive = true; captureSelection(); });
        sizeSel.addEventListener('change', () => {
            const v = sizeSel.value;
            sizeSel.value = ''; // wróć do labelki
            restoreSel();
            const sel = window.getSelection();
            if (v && sel && sel.rangeCount && !sel.isCollapsed) {
                // V to designerski rozmiar (pt), w edytorze mnożymy przez zoom (CSS px ≠ design pt).
                const span = wrapRangeWithStyle(sel.getRangeAt(0), 'fontSize', (parseFloat(v) * z) + 'px');
                if (span) {
                    const nr = document.createRange();
                    nr.selectNodeContents(span);
                    sel.removeAllRanges(); sel.addRange(nr);
                    savedSelRange = nr.cloneRange();
                }
            }
            endFormatting();
        });
        sizeWrap.appendChild(sizeSel);
        bar.appendChild(sizeWrap);

        bar.appendChild(mkSep());

        // ── Wyrównanie akapitu (lewo / środek / prawo / justuj) — z aktywnym stanem ──
        const setParaAlign = (align) => {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) { ed.focus(); return; }
            const range = sel.getRangeAt(0);
            const blocks = Array.from(ed.children).filter((n) => n.nodeType === 1);
            const targets = blocks.length ? blocks.filter((bk) => range.intersectsNode(bk)) : [ed];
            for (const bk of targets) bk.style.textAlign = align;
            ed.focus();
        };
        const alignBtns = {};
        const mkAlignBtn = (icon, align, title) => {
            const b = baseBtn();
            b.innerHTML = '<i class="ti ti-' + icon + '"></i>';
            b.title = title;
            b.addEventListener('mousedown', (e) => {
                e.preventDefault();
                setParaAlign(align);
                Object.values(alignBtns).forEach((x) => setActive(x, false));
                setActive(b, true);
            });
            alignBtns[align] = b;
            return b;
        };
        bar.appendChild(mkAlignBtn('align-left', 'left', 'Akapit do lewej'));
        bar.appendChild(mkAlignBtn('align-center', 'center', 'Akapit wyśrodkowany'));
        bar.appendChild(mkAlignBtn('align-right', 'right', 'Akapit do prawej'));
        bar.appendChild(mkAlignBtn('align-justified', 'justify', 'Wyjustuj akapit'));

        bar.appendChild(mkSep());

        // ── Letter-spacing per AKAPIT (ikona + input numeryczny, krok 0.1 pt) ──
        const setParaSpacing = (spPt) => {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) { ed.focus(); return; }
            const range = sel.getRangeAt(0);
            const blocks = Array.from(ed.children).filter((n) => n.nodeType === 1);
            const targets = blocks.length ? blocks.filter((bk) => range.intersectsNode(bk)) : [ed];
            for (const bk of targets) {
                bk.style.letterSpacing = (spPt === 0 || spPt == null) ? '' : (spPt * z) + 'px';
            }
            ed.focus();
        };
        const spWrap = document.createElement('div');
        Object.assign(spWrap.style, { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '0 4px' });
        const spIcon = document.createElement('i');
        spIcon.className = 'ti ti-letter-spacing';
        Object.assign(spIcon.style, { fontSize: '15px', color: '#6c7793' });
        spWrap.appendChild(spIcon);
        // Input liczbowy: odstęp znaków akapitu w pt, krok 0.1 (zakres -2 … 10).
        const spInp = document.createElement('input');
        spInp.type = 'number';
        spInp.step = '0.1';
        spInp.min = '-2';
        spInp.max = '10';
        spInp.placeholder = '0';
        spInp.title = 'Odstęp znaków akapitu (pt; krok 0.1; np. 0.5 = rozstrzelony, -0.5 = zwężony)';
        Object.assign(spInp.style, {
            width: '52px', height: '26px', background: '#fff', color: '#2a3247',
            border: '1px solid #d8dde5', borderRadius: '5px', padding: '0 4px', fontSize: '12px',
            textAlign: 'center', outline: 'none',
        });
        spInp.addEventListener('mousedown', () => { formatActive = true; captureSelection(); });
        spInp.addEventListener('focus', () => { formatActive = true; });
        const applySpacing = () => {
            restoreSel();
            const raw = spInp.value;
            if (raw === '') { setParaSpacing(0); }
            else {
                const v = parseFloat(raw);
                if (Number.isFinite(v)) { setParaSpacing(v); }
            }
            endFormatting();
        };
        spInp.addEventListener('change', applySpacing);
        spInp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); applySpacing(); spInp.blur(); }
            // Strzałki ↑/↓ — natywny step input typeu number (0.1 pt każde naciśnięcie).
        });
        spWrap.appendChild(spInp);
        bar.appendChild(spWrap);

        bar.appendChild(mkSep());

        // ── Przycisk „Wyczyść formatowanie" — usuwa kolory/style/bold/italic ze ZAZNACZENIA lub CAŁOŚCI. ──
        // Przydatny gdy ktoś wkleił tekst PRZED tym że paste był sanitizowany (legacy zawartość ramki).
        const cleanBtn = baseBtn();
        cleanBtn.innerHTML = '<i class="ti ti-eraser"></i>';
        cleanBtn.title = 'Wyczyść formatowanie zaznaczenia (kolory, kursywa, pogrubienie, fonty). Bez zaznaczenia — czyści całość ramki.';
        cleanBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const sel = window.getSelection();
            const hasSelection = sel && sel.rangeCount && !sel.isCollapsed && ed.contains(sel.getRangeAt(0).commonAncestorContainer);
            if (hasSelection) {
                // Zaznaczenie → zastąp je czystym tekstem (zachowując \n jako podział linii w execCommand).
                const txt = sel.toString();
                ed.focus();
                try { document.execCommand('insertText', false, txt); }
                catch (_) { /* OK — w razie braku wsparcia, nic nie rób */ }
            } else {
                // Brak zaznaczenia → przebuduj całość: każda linia tekstu = osobny <div> bez stylów.
                const text = ed.innerText || ed.textContent || '';
                ed.innerHTML = '';
                for (const line of text.split('\n')) {
                    const div = document.createElement('div');
                    if (line) { div.textContent = line; } else { div.appendChild(document.createElement('br')); }
                    ed.appendChild(div);
                }
                // Karetka na koniec
                ed.focus();
                const r = document.createRange();
                r.selectNodeContents(ed);
                r.collapse(false);
                const s = window.getSelection();
                s.removeAllRanges(); s.addRange(r);
            }
        });
        bar.appendChild(cleanBtn);

        // ── Przycisk „AI" — fioletowy gradient, redaguje zaznaczony fragment (lub cały tekst). ──
        const aiBtn = document.createElement('button');
        aiBtn.type = 'button';
        aiBtn.innerHTML = '<i class="ti ti-sparkles" style="font-size:14px;line-height:1"></i><span>AI</span>';
        aiBtn.title = 'Redaguj zaznaczony fragment z pomocą AI';
        Object.assign(aiBtn.style, {
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            height: '28px', padding: '0 11px',
            border: 'none', borderRadius: '7px',
            background: 'linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%)',
            color: '#fff', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: '12.5px', fontWeight: '600', lineHeight: '1',
            boxShadow: '0 1px 3px rgba(91,33,182,.35)',
            transition: 'filter .12s ease, transform .12s ease',
        });
        aiBtn.addEventListener('mouseenter', () => { aiBtn.style.filter = 'brightness(1.08)'; });
        aiBtn.addEventListener('mouseleave', () => { aiBtn.style.filter = ''; });
        aiBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const sel = window.getSelection();
            let r = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : null;
            if (!r || r.collapsed || !ed.contains(r.commonAncestorContainer)) {
                r = document.createRange();
                r.selectNodeContents(ed);
            }
            savedRange = r;
            openAiPanel();
        });
        bar.appendChild(aiBtn);

        document.body.appendChild(bar);
        // Po zmierzeniu rzeczywistej wysokości — przesuń pasek pionowo tuż nad pole.
        const _bh = bar.offsetHeight || 38;
        bar.style.top = Math.max(window.scrollY + 4, top - _bh - 6) + 'px';

        // Synchronizacja stanu (B/I/wyrównanie/odstęp) z bieżącym zaznaczeniem.
        const syncBar = () => {
            if (!ed.isConnected) { return; }
            // Tylko gdy fokus jest w polu edycji (uniknij konfliktu z aktywnym selectem/inputem).
            const ae = document.activeElement;
            if (ae !== ed && !ed.contains(ae)) { return; }
            try {
                setActive(boldBtn, document.queryCommandState('bold'));
                setActive(italBtn, document.queryCommandState('italic'));
            } catch (_) { /* brak wsparcia w przegl. */ }
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) { return; }
            const node = sel.getRangeAt(0).startContainer;
            const targetEl = (node && node.nodeType === 1) ? node : (node && node.parentElement);
            // ── Rozmiar fontu (computed px → pt) — pokaż w pierwszej opcji selecta ──
            if (targetEl && ae !== sizeSel) {
                try {
                    const cssPx = parseFloat(window.getComputedStyle(targetEl).fontSize);
                    if (Number.isFinite(cssPx) && cssPx > 0) {
                        const pt = cssPx / z;
                        const ptInt = Math.round(pt);
                        const label = (Math.abs(pt - ptInt) < 0.1) ? String(ptInt) : pt.toFixed(1);
                        defaultOpt.textContent = label + ' pt';
                        sizeSel.value = '';
                    }
                } catch (_) { /* OK */ }
            }
            let bk = targetEl;
            while (bk && bk.parentElement !== ed) { bk = bk.parentElement; }
            if (!bk || bk.parentElement !== ed) { return; }
            const al = (bk.style.textAlign || '').toLowerCase();
            const k = (['left', 'center', 'right', 'justify'].includes(al)) ? al : 'left';
            Object.entries(alignBtns).forEach(([key, btn]) => setActive(btn, key === k));
            // Odstęp znaków → pt (cofnij mnożenie przez z).
            const lsCss = bk.style.letterSpacing;
            if (lsCss && /px/i.test(lsCss)) {
                const m = String(lsCss).match(/^(-?[\d.]+)\s*px/i);
                if (m) {
                    const pt = parseFloat(m[1]) / z;
                    if (Number.isFinite(pt) && ae !== spInp) {
                        spInp.value = (Math.round(pt * 10) / 10).toString();
                    }
                }
            } else if (ae !== spInp) {
                spInp.value = '';
            }
        };
        document.addEventListener('selectionchange', syncBar);
        bar._cleanupSync = () => document.removeEventListener('selectionchange', syncBar);

        ed.focus();
        // Zaznacz całość przy wejściu.
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(ed);
        sel.removeAllRanges();
        sel.addRange(range);
        // Wymuś pierwszą synchronizację (selectionchange może nie zdążyć przed pierwszym renderem).
        requestAnimationFrame(syncBar);

        let done = false;
        const commit = () => {
            if (done) return;
            done = true;
            try {
                // Usuń „blokery" oblewania — nie należą do treści; inaczej trafiłyby do runs.
                ed.querySelectorAll('[data-gz-wrap]').forEach((n) => n.remove());
                const { text, runs, paraAlign, paraSpacing } = this.runsFromHtml(ed, z);
                el.text = text;
                if (runs.some((r) => r.b || r.i || r.c || r.s)) { el.runs = runs; }
                else { delete el.runs; }
                if (paraAlign.some((a) => a)) { el.paraAlign = paraAlign; }
                else { delete el.paraAlign; }
                if (paraSpacing && paraSpacing.some((sp) => sp != null && sp !== 0)) { el.paraSpacing = paraSpacing; }
                else { delete el.paraSpacing; }
            } catch (e) {
                console.error('[gz] BŁĄD zapisu tekstu:', e);
            }
            ed.remove();
            if (overlay) { overlay.remove(); overlay = null; }
            try { bar._cleanupSync && bar._cleanupSync(); } catch (_) { /* OK */ }
            bar.remove();
            if (aiPanel) { aiPanel.remove(); aiPanel = null; }
            this.markDirty();
            this.renderPage();
            this.select(el.id);
        };
        // Gdy panel AI lub paleta koloru/rozmiaru jest otwarta, utrata fokusu NIE zamyka edycji.
        ed.addEventListener('blur', () => { if (!aiOpen && !formatActive) commit(); });
        ed.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); if (aiOpen) closeAiPanel(false); else ed.blur(); }
        });
        // ── Czyszczenie wklejanego tekstu (paste sanitization) ──
        // Wklejanie ze stron WWW przynosi śmieci: <span style="…">, kolory, fonty, klasy.
        // Zamiast tego wstawiamy CZYSTY TEKST (zachowując nowe linie jako akapity).
        ed.addEventListener('paste', (e) => {
            e.preventDefault();
            const cb = e.clipboardData || window.clipboardData;
            if (!cb) { return; }
            const text = cb.getData('text/plain') || '';
            if (!text) { return; }
            // execCommand('insertText') szanuje aktualne zaznaczenie i konwertuje \n na <br>/<div> wg przeglądarki.
            try { document.execCommand('insertText', false, text); }
            catch (_) {
                // Fallback: ręczne wstawienie text-node.
                const sel = window.getSelection();
                if (!sel || !sel.rangeCount) { return; }
                const r = sel.getRangeAt(0);
                r.deleteContents();
                r.insertNode(document.createTextNode(text));
                r.collapse(false);
                sel.removeAllRanges(); sel.addRange(r);
            }
        });
    }

    /**
     * Wywołuje serwerowe redagowanie fragmentu z pomocą AI i zwraca SAM zredagowany tekst.
     * @param {string} action  — preset: rephrase|shorten|expand|fix|simplify|formal|custom
     * @param {string} instruction — własne polecenie (dla action='custom')
     * @param {string} fragment — zaznaczony tekst do zredagowania
     * @param {string} context  — pełny tekst ramki (dla zachowania tonu/tematu)
     */
    async aiRedact(action, instruction, fragment, context) {
        const res = await fetch(this.aiRedactUrlValue, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': this.csrfValue,
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: JSON.stringify({ action, instruction, text: fragment, context }),
        });
        const data = await res.json().catch(() => ({ ok: false, error: 'Błędna odpowiedź serwera.' }));
        if (!data.ok) throw new Error(data.error || 'Nie udało się zredagować tekstu.');
        return data.text;
    }

    /** Buduje HTML pola edycji: JEDEN <div> na akapit (z text-align z el.paraAlign), w środku <b>/<i>. */
    htmlFromRuns(el, zoom) {
        const z = zoom || 1;
        const runs = (Array.isArray(el.runs) && el.runs.length) ? el.runs : [{ t: el.text || '' }];
        // Rozbij runs na akapity (po \n), zachowując style fragmentów.
        const paras = [[]];
        for (const r of runs) {
            const parts = String(r.t).split('\n');
            for (let pi = 0; pi < parts.length; pi++) {
                if (pi > 0) paras.push([]);
                if (parts[pi]) paras[paras.length - 1].push({ t: parts[pi], b: r.b, i: r.i, c: r.c, s: r.s });
            }
        }
        let html = '';
        paras.forEach((segRuns, idx) => {
            let inner = '';
            for (const r of segRuns) {
                let t = escapeHtml(r.t);
                if (r.i) t = '<i>' + t + '</i>';
                if (r.b) t = '<b>' + t + '</b>';
                const styles = [];
                if (r.c) { styles.push('color:' + r.c); }
                // font-size w edytorze trzeba pomnożyć przez zoom — el.fontSize CSS ramki też jest * z.
                if (r.s) { styles.push('font-size:' + (r.s * z) + 'px'); }
                if (styles.length) { t = '<span style="' + styles.join(';') + '">' + t + '</span>'; }
                inner += t;
            }
            if (!inner) inner = '<br>';
            const a = (el.paraAlign && el.paraAlign[idx]) || '';
            const ps = (el.paraSpacing && el.paraSpacing[idx] != null) ? el.paraSpacing[idx] : null;
            const divStyles = [];
            if (a) { divStyles.push('text-align:' + a); }
            if (ps != null) { divStyles.push('letter-spacing:' + (ps * z) + 'px'); }
            const styleAttr = divStyles.length ? ' style="' + divStyles.join(';') + '"' : '';
            html += '<div' + styleAttr + '>' + inner + '</div>';
        });
        return html || '<div><br></div>';
    }

    /**
     * Serializuje contenteditable do {text, runs, paraAlign}. Akapit = blok (DIV/P) lub fragment
     * rozdzielony BR; wyrównanie akapitu = text-align jego bloku. <b>/<strong>/font-weight→bold,
     * <i>/<em>/font-style→italic.
     */
    runsFromHtml(root, zoom) {
        const z = zoom || 1;
        const paras = [];          // { align:'', spacing:null|number, runs:[{t,b,i,c,s}] }
        let cur = null;
        let curAlign = '';
        let curSpacing = null;
        const startPara = () => { cur = { align: curAlign, spacing: curSpacing, runs: [] }; paras.push(cur); };
        const sameStyle = (a, b) => !!a.b === !!b.b && !!a.i === !!b.i
            && (a.c || '') === (b.c || '') && (a.s || 0) === (b.s || 0);
        const pushText = (t, b, i, c, s) => {
            if (!t) return;
            if (!cur) startPara();
            const last = cur.runs[cur.runs.length - 1];
            const nu = { b: b || undefined, i: i || undefined, c: c || undefined, s: s || undefined };
            if (last && sameStyle(last, nu)) { last.t += t; }
            else { cur.runs.push({ t, ...nu }); }
        };
        // Parsuj kolor (hex, rgb()) → '#rrggbb'. Named colors traktowane jako null (rzadkie po naszym wrap span).
        const hex2 = (n) => ('0' + Math.max(0, Math.min(255, parseInt(n, 10))).toString(16)).slice(-2);
        const parseColor = (str) => {
            if (!str) { return null; }
            const s = String(str).trim();
            if (s === '' || s === 'inherit' || s === 'initial' || s === 'transparent' || s === 'currentcolor') { return null; }
            if (/^#[0-9a-fA-F]{3,8}$/.test(s)) { return s.length === 4 ? '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] : s; }
            const m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
            if (m) { return '#' + hex2(m[1]) + hex2(m[2]) + hex2(m[3]); }
            return null;
        };
        // Parsuj rozmiar w px → liczba (akceptuje też wartości ujemne, np. letter-spacing -1px).
        const parseSize = (str) => {
            if (!str) { return null; }
            const m = String(str).trim().match(/^(-?[\d.]+)\s*px/i);
            return m ? parseFloat(m[1]) : null;
        };
        const walk = (node, b, i, c, s) => {
            for (const child of node.childNodes) {
                if (child.nodeType === 3) { pushText(child.nodeValue, b, i, c, s); continue; }
                if (child.nodeType !== 1) continue;
                const tag = child.tagName;
                if (tag === 'BR') {
                    if (!cur) startPara();
                    if (child.nextSibling) cur = null;
                    continue;
                }
                const st = child.style || {};
                if (/^(DIV|P)$/.test(tag)) {
                    const prev = curAlign;
                    const prevSpacing = curSpacing;
                    const a = (st.textAlign || '').toLowerCase();
                    curAlign = (a === 'left' || a === 'right' || a === 'center' || a === 'justify') ? a : prev;
                    // letter-spacing per akapit — dzielimy przez zoom by zapisać „designerską" wartość pt.
                    const ls = parseSize(st.letterSpacing);
                    curSpacing = (ls !== null) ? Math.round((ls / z) * 10) / 10 : prevSpacing;
                    cur = null;
                    startPara();
                    walk(child, b, i, c, s);
                    cur = null;
                    curAlign = prev;
                    curSpacing = prevSpacing;
                } else {
                    const fw = st.fontWeight;
                    const nb = b || tag === 'B' || tag === 'STRONG' || fw === 'bold' || (fw && parseInt(fw, 10) >= 600);
                    const ni = i || tag === 'I' || tag === 'EM' || st.fontStyle === 'italic';
                    // execCommand foreColor produkuje <font color="..."> w niektórych przeglądarkach
                    const colorAttr = st.color || child.getAttribute('color');
                    const nc = parseColor(colorAttr) || c;
                    // font-size w edytorze jest * z; chcemy zachować w runs „designerski" rozmiar (bez zoom).
                    const parsedSize = parseSize(st.fontSize);
                    const ns = (parsedSize !== null) ? Math.round((parsedSize / z) * 10) / 10 : s;
                    walk(child, nb, ni, nc, ns);
                }
            }
        };
        walk(root, false, false, null, null);
        if (!paras.length) paras.push({ align: '', runs: [] });

        const runs = [];
        const paraAlign = [];
        const paraSpacing = [];
        paras.forEach((p, idx) => {
            if (idx > 0) runs.push({ t: '\n' });
            for (const r of p.runs) {
                const last = runs[runs.length - 1];
                const same = last && !!last.b === !!r.b && !!last.i === !!r.i
                    && (last.c || '') === (r.c || '') && (last.s || 0) === (r.s || 0);
                if (same) { last.t += r.t; }
                else { runs.push({ t: r.t, b: r.b, i: r.i, c: r.c, s: r.s }); }
            }
            paraAlign.push(p.align || '');
            paraSpacing.push(p.spacing != null ? p.spacing : null);
        });
        const text = runs.map((r) => r.t).join('');
        return { text, runs, paraAlign, paraSpacing };
    }

    // ─── Akcje paska narzędzi ───────────────────────────────

    addText() {
        const el = {
            id: uid(), type: 'text',
            x: 40, y: 40, width: 320, height: 120, rotation: 0, opacity: 1,
            text: 'Kliknij dwukrotnie, aby edytować tekst.',
            fontSize: 16, fontFamily: 'Georgia', fontStyle: 'normal',
            fill: '#1a2330', align: 'left', lineHeight: 1.35, columns: 1, columnGap: 14,
        };
        this.addElement(el);
    }

    addHeading() {
        const el = {
            id: uid(), type: 'text',
            x: 40, y: 30, width: this.pageW - 80, height: 60, rotation: 0, opacity: 1,
            text: 'Tytuł artykułu',
            fontSize: 30, fontFamily: 'Georgia', fontStyle: 'bold',
            fill: '#0b1f3a', align: 'left', lineHeight: 1.1, columns: 1, columnGap: 14,
        };
        this.addElement(el);
    }

    addRect() {
        this.addElement({
            id: uid(), type: 'rect',
            x: 60, y: 60, width: 180, height: 120, rotation: 0, opacity: 1,
            fill: '#dbe7ff', stroke: '#1a56db', strokeWidth: 0, cornerRadius: 6,
        });
    }

    addLine() {
        this.addElement({
            id: uid(), type: 'line',
            x: 40, y: 100, width: this.pageW - 80, height: 0, rotation: 0, opacity: 1,
            stroke: '#1a2330', strokeWidth: 2,
        });
    }

    addElement(el) {
        this.page().elements.push(el);
        this.markDirty();
        this.renderPage();
        this.select(el.id);
    }

    pickImage() {
        this._fillFrameId = null; // upload tworzy NOWY element
        this.fileTarget.click();
    }

    /** Dodaje PUSTĄ ramkę graficzną — placeholder do późniejszego wypełnienia (dwuklik = wybór źródła). */
    addImageFrame() {
        const w = 220, h = 165;
        this.addElement({
            id: uid(), type: 'image',
            x: round((this.pageW - w) / 2), y: round((this.pageH - h) / 2),
            width: w, height: h, rotation: 0, opacity: 1,
            src: '', // pusta ramka — render jako placeholder
            frameShape: 'rect',
            wrapText: true, wrapGap: 9,
        });
        if (this.hasStatusTarget) { this.statusTarget.textContent = 'Pusta ramka graficzna dodana — zmień kształt w panelu i dwuklik aby wstawić zdjęcie.'; }
    }

    /** Otwiera modal wyboru źródła zdjęcia dla wskazanej (PUSTEJ) ramki. */
    openImageSourcePickerFor(el) {
        if (!el) { return; }
        this._fillFrameId = el.id;
        const modalEl = document.getElementById('gzPickImageSourceModal');
        if (!modalEl) {
            if (this.hasStatusTarget) { this.statusTarget.textContent = 'Błąd: brak modala gzPickImageSourceModal.'; }
            // Fallback: bez modala — pytaj wprost.
            const fromDisk = confirm('Wstaw zdjęcie do ramki:\n\n  OK = Z DYSKU (upload)\n  Anuluj = Z BIBLIOTEKI mediów');
            if (fromDisk) { this.pickFrameImageFromDisk(); } else { this.pickFrameImageFromLibrary(); }
            return;
        }
        if (window.bootstrap && window.bootstrap.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
            return;
        }
        // Awaryjnie: pokaż modal przez JS-ową manipulację klasami (gdy bootstrap.Modal niedostępne).
        modalEl.classList.add('show'); modalEl.style.display = 'block';
        modalEl.removeAttribute('aria-hidden'); modalEl.setAttribute('aria-modal', 'true');
        document.body.classList.add('modal-open');
        if (this.hasStatusTarget) { this.statusTarget.textContent = 'Wybierz źródło zdjęcia…'; }
    }

    /**
     * Brute-force domknięcie DOWOLNEGO modala — synchroniczne, bez czekania na zdarzenia Bootstrap.
     * Powód: po dispose() jednego modala (przy chainowaniu) Bootstrap traci kontekst i `data-bs-dismiss`
     * w kolejnych modalach może milczeć → strona „zawisa". Wszystkie modale zamykamy tą samą metodą.
     */
    _brutalCloseModal(modalId) {
        const el = document.getElementById(modalId);
        if (!el) { return; }
        if (window.bootstrap && window.bootstrap.Modal) {
            const inst = window.bootstrap.Modal.getInstance(el);
            if (inst) { try { inst.dispose(); } catch (_) { /* OK */ } }
        }
        el.classList.remove('show');
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
        el.removeAttribute('aria-modal');
        // Sprzątanie body + backdropów (gdy żaden inny modal nie jest aktywny).
        const anyOpen = document.querySelector('.modal.show');
        if (!anyOpen) {
            document.body.classList.remove('modal-open');
            document.body.style.removeProperty('padding-right');
            document.body.style.removeProperty('overflow');
            document.querySelectorAll('.modal-backdrop').forEach((bd) => bd.remove());
        }
    }

    /** Alias dla wsparcia starego nazewnictwa wewnętrznego. */
    _closePickImageSourceModal() { this._brutalCloseModal('gzPickImageSourceModal'); }

    /** Z modala wyboru źródła → upload z dysku do bieżącej ramki. */
    pickFrameImageFromDisk() {
        if (!this._fillFrameId) { return; }
        this._closePickImageSourceModal();
        // Krótka pauza by DOM się odświeżył przed otwarciem natywnego file pickera.
        setTimeout(() => this.fileTarget.click(), 30);
    }

    /** Z modala wyboru źródła → biblioteka mediów. Brute-close + krótki delay + explicit loadMedia. */
    pickFrameImageFromLibrary() {
        if (!this._fillFrameId) { return; }
        this._closePickImageSourceModal();
        // Krótka pauza: DOM się odświeża po manual-hide → Bootstrap czysto wystartuje drugi modal.
        setTimeout(() => {
            const modalEl = document.getElementById('gzMediaModal');
            if (!modalEl) { return; }
            // Explicit fetch listy — NIE polegamy na shown.bs.modal (po brute-hide może nie zafire'ować
            // dla SVELLO-otwartego modala mediów).
            try { this.loadMedia(); } catch (_) { /* OK */ }
            if (window.bootstrap && window.bootstrap.Modal) {
                window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
            } else {
                modalEl.classList.add('show'); modalEl.style.display = 'block';
                modalEl.removeAttribute('aria-hidden'); modalEl.setAttribute('aria-modal', 'true');
                document.body.classList.add('modal-open');
            }
            if (this.hasStatusTarget) { this.statusTarget.textContent = 'Wybierz zdjęcie z biblioteki…'; }
        }, 60);
    }

    /** Podstawia src pod istniejącą RAMKĘ (zamiast tworzyć nowy element) + auto-dopasowanie ramki do proporcji obrazu.
     *  Bez tego obraz byłby naciągnięty (stretching) — computeImageFit fallback wypełnia ramkę dokładnie. */
    _fillFrameWithImage(frameId, src) {
        const frame = this.page().elements.find((e) => e.id === frameId);
        if (!frame) { this._fillFrameId = null; return false; }
        frame.src = src;
        delete frame.fit;
        delete frame.crop;
        this._fillFrameId = null;
        this.markDirty();
        this.renderPage();
        this.select(frame.id);
        // Po podstawieniu (gdy obraz się załaduje) — auto-dopasowanie wysokości do proporcji.
        this._adjustFrameToImageAspect(frame);
        return true;
    }

    /** Dopasuje wysokość ramki (zachowując szerokość) do proporcji wczytanego obrazu — żeby nie deformować.
     *  Środek ramki zostaje na miejscu (przesuwamy `y` o połowę różnicy wysokości). */
    _adjustFrameToImageAspect(frame) {
        if (!frame || frame.type !== 'image' || !frame.src) { return; }
        const img = this.getImage(frame.src);
        const apply = () => {
            if (!img.naturalWidth || !img.naturalHeight) { return; }
            const imgRatio = img.naturalWidth / img.naturalHeight;
            const oldH = frame.height || 1;
            const newH = Math.max(20, Math.round((frame.width || 1) / imgRatio));
            if (Math.abs(newH - oldH) < 1) { return; } // już dopasowane
            frame.height = newH;
            frame.y = Math.round((frame.y || 0) + (oldH - newH) / 2);
            // Reset kadru (obraz wypełni nowe wymiary bez naciągania).
            delete frame.fit;
            delete frame.crop;
            this.markDirty();
            this.renderPage();
            this.select(frame.id);
            if (this.hasStatusTarget) { this.statusTarget.textContent = 'Ramka dopasowana do proporcji zdjęcia.'; }
        };
        if (img.complete && img.naturalWidth) { apply(); }
        else { img.addEventListener('load', apply, { once: true }); }
    }

    /** Akcja Stimulus: ręczny reset proporcji ramki do proporcji zdjęcia (gdy user nakroił ramkę nie tak). */
    resetFrameToImageRatio() {
        const el = this.selectedEl();
        if (!el || el.type !== 'image' || !el.src) {
            if (this.hasStatusTarget) { this.statusTarget.textContent = 'Najpierw zaznacz ramkę z wczytanym zdjęciem.'; }
            return;
        }
        this._adjustFrameToImageAspect(el);
    }

    async onFileChosen(event) {
        const input = event.target;
        const file = input.files && input.files[0];
        if (!file) return;
        input.value = '';

        this.statusTarget.textContent = 'Wgrywanie zdjęcia…';
        const fd = new FormData();
        fd.append('image', file);
        try {
            const res = await fetch(this.uploadUrlValue, {
                method: 'POST',
                headers: { 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: fd,
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd wgrywania.');

            // Jeśli czekamy na wypełnienie istniejącej ramki — uzupełnij src zamiast tworzyć nowy element.
            if (this._fillFrameId && this._fillFrameWithImage(this._fillFrameId, data.url)) {
                this.statusTarget.textContent = 'Zdjęcie wstawione do ramki.';
                return;
            }

            // Tryb domyślny: dodaj jako nowy element wyśrodkowany.
            const maxW = this.pageW * 0.6;
            const maxH = this.pageH * 0.5;
            let w = data.width || 240;
            let h = data.height || 180;
            const ratio = Math.min(maxW / w, maxH / h, 1);
            w = round(w * ratio); h = round(h * ratio);

            this.addElement({
                id: uid(), type: 'image',
                x: round((this.pageW - w) / 2), y: 80, width: w, height: h,
                rotation: 0, opacity: 1, src: data.url, wrapText: true, wrapGap: 9,
            });
            this.statusTarget.textContent = 'Zdjęcie dodane.';
        } catch (e) {
            this.statusTarget.textContent = 'Błąd wgrywania zdjęcia.';
            console.error('Upload zdjęcia:', e);
            alert('Nie udało się wgrać zdjęcia: ' + e.message);
        }
    }

    deleteSelected() {
        if (!this.selectedIds.length) return;
        const ids = new Set(this.selectedIds);
        this.page().elements = this.page().elements.filter((e) => !ids.has(e.id));
        this.select(null);
        this.markDirty();
        this.renderPage();
    }

    duplicateSelected() {
        const selIds = this.selectedIds.slice();
        const els = this.selectedElements();
        if (!els.length) return;

        // Inteligentne duplikowanie à la QuarkXPress (Step & Repeat):
        // Jeśli AKTUALNE zaznaczenie to wynik POPRZEDNIEGO Ctrl+D, policz delta
        // (bieżąca pozycja − pozycja źródła) i użyj jej jako offsetu nowego klonu.
        // Dzięki temu kolejne kopie zachowują równe odstępy — np. powtarzasz
        // kwadrat 100 px w dół i dostajesz kolumnę kwadratów. Inaczej domyślne (16, 16).
        let dx = 16, dy = 16;
        if (this._lastDup && this._lastDup.pairs.length
            && this._lastDup.pairs.every((p) => selIds.includes(p.newId))) {
            let sumDx = 0, sumDy = 0, n = 0;
            for (const p of this._lastDup.pairs) {
                const newEl = this.elById(p.newId);
                const srcEl = this.elById(p.srcId);
                if (newEl && srcEl) {
                    sumDx += (newEl.x || 0) - (srcEl.x || 0);
                    sumDy += (newEl.y || 0) - (srcEl.y || 0);
                    n++;
                }
            }
            if (n > 0) {
                dx = Math.round(sumDx / n);
                dy = Math.round(sumDy / n);
            }
        }

        const block = this.cloneBlock(els, dx, dy);
        for (const c of block) this.page().elements.push(c);
        this.selectAll(block.map((c) => c.id));

        // Zapamiętaj pary (nowy ↔ źródło). Kolejny Ctrl+D na tej selekcji wyliczy delta
        // z ewentualnego ręcznego przesunięcia tych nowych elementów.
        this._lastDup = {
            pairs: els.map((src, i) => ({ newId: block[i].id, srcId: src.id })),
        };
    }

    // ─── Grupowanie ─────────────────────────────────────────

    groupSelected() {
        if (this.selectedIds.length < 2) {
            this.statusTarget.textContent = 'Zaznacz co najmniej 2 elementy (Shift+klik lub ramką), aby zgrupować.';
            return;
        }
        const gid = 'g_' + Math.random().toString(36).slice(2, 9);
        for (const id of this.selectedIds) { const el = this.elById(id); if (el) el.groupId = gid; }
        this.markDirty();
        this.renderPage();
        this.reattachTransformer();
        this.statusTarget.textContent = 'Zgrupowano ' + this.selectedIds.length + ' elementów.';
    }

    ungroupSelected() {
        let n = 0;
        for (const id of this.selectedIds) { const el = this.elById(id); if (el && el.groupId) { delete el.groupId; n++; } }
        if (n) {
            this.markDirty();
            this.renderPage();
            this.reattachTransformer();
            this.statusTarget.textContent = 'Rozgrupowano.';
        }
    }

    /** Ustawia selekcję na podaną listę id (po dodaniu/wklejeniu elementów). */
    selectAll(ids) {
        this.selectedIds = ids.slice();
        this.selectedId = ids.length === 1 ? ids[0] : null;
        this.markDirty();
        this.renderPage();
        this.reattachTransformer();
        this.syncProps();
    }

    /** Klonuje blok elementów: świeże id, offset (dx,dy); zachowuje wewn. grupy (nowe groupId) lub wymusza jedną grupę. */
    cloneBlock(els, dx = 0, dy = 0, oneGroup = null) {
        const gmap = {};
        return els.map((src) => {
            const c = JSON.parse(JSON.stringify(src));
            c.id = uid();
            c.x = (c.x || 0) + dx;
            c.y = (c.y || 0) + dy;
            if (oneGroup) c.groupId = oneGroup;
            else if (c.groupId) { if (!gmap[c.groupId]) gmap[c.groupId] = 'g_' + Math.random().toString(36).slice(2, 9); c.groupId = gmap[c.groupId]; }
            return c;
        });
    }

    // ─── Schowek (kopiuj / wytnij / wklej — bloki, także między stronami) ───

    copySelected() {
        const els = this.selectedElements();
        if (!els.length) return;
        this.clipboard = els.map((e) => JSON.parse(JSON.stringify(e)));
        this.statusTarget.textContent = 'Skopiowano ' + els.length + ' el. — wklej (Ctrl+V) na dowolnej stronie';
    }

    cutSelected() {
        const els = this.selectedElements();
        if (!els.length) return;
        this.clipboard = els.map((e) => JSON.parse(JSON.stringify(e)));
        const ids = new Set(this.selectedIds);
        this.page().elements = this.page().elements.filter((e) => !ids.has(e.id));
        this.select(null);
        this.markDirty();
        this.renderPage();
        this.statusTarget.textContent = 'Wycięto ' + els.length + ' el. — wklej (Ctrl+V) na dowolnej stronie';
    }

    pasteClipboard() {
        if (!this.clipboard || !this.clipboard.length) return;
        const block = this.cloneBlock(this.clipboard, 16, 16); // świeże id, zachowane grupy
        for (const c of block) this.page().elements.push(c);   // wkleja na BIEŻĄCĄ stronę
        this.selectAll(block.map((c) => c.id));
    }

    bringForward() {
        const els = this.page().elements;
        const i = els.findIndex((e) => e.id === this.selectedId);
        if (i >= 0 && i < els.length - 1) {
            [els[i], els[i + 1]] = [els[i + 1], els[i]];
            this.markDirty();
            this.renderPage();
            this.select(this.selectedId);
        }
    }

    sendBackward() {
        const els = this.page().elements;
        const i = els.findIndex((e) => e.id === this.selectedId);
        if (i > 0) {
            [els[i], els[i - 1]] = [els[i - 1], els[i]];
            this.markDirty();
            this.renderPage();
            this.select(this.selectedId);
        }
    }

    /** Przenosi zaznaczony element na samą górę warstw (nad wszystkie). */
    bringToFront() {
        const els = this.page().elements;
        const i = els.findIndex((e) => e.id === this.selectedId);
        if (i >= 0 && i < els.length - 1) {
            const [el] = els.splice(i, 1);
            els.push(el);
            this.markDirty();
            this.renderPage();
            this.select(this.selectedId);
        }
    }

    /** Przenosi zaznaczony element na sam spód warstw (pod wszystkie — np. tło). */
    sendToBack() {
        const els = this.page().elements;
        const i = els.findIndex((e) => e.id === this.selectedId);
        if (i > 0) {
            const [el] = els.splice(i, 1);
            els.unshift(el);
            this.markDirty();
            this.renderPage();
            this.select(this.selectedId);
        }
    }

    // ─── Magazyn bloków (zapisane, zgrupowane zestawy elementów — zapis na SERWERZE, per użytkownik) ───

    setBlockStatus(msg, err) {
        const el = this.element.querySelector('[data-block="status"]');
        if (el) { el.textContent = msg; el.className = 'small mb-2 ' + (err ? 'text-danger' : 'text-secondary'); }
    }

    /** Pobiera bloki użytkownika z serwera do this._blocks. */
    async fetchBlocks() {
        const res = await fetch(this.blocksUrlValue, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Błąd wczytywania bloków.');
        this._blocks = data.items || [];
        return this._blocks;
    }

    /** Zapisuje bieżącą selekcję jako blok wielokrotnego użytku (z miniaturą) na serwerze. */
    async saveSelectionAsBlock() {
        const els = this.selectedElements();
        if (!els.length) { this.setBlockStatus('Najpierw zaznacz elementy (Shift+klik lub ramką).', true); return; }
        const bb = this.blockBBox(els);
        const norm = els.map((e) => { const c = JSON.parse(JSON.stringify(e)); c.x = (c.x || 0) - bb.x; c.y = (c.y || 0) - bb.y; return c; });
        const name = (prompt('Nazwa bloku:', 'Mój blok') || '').trim();
        if (!name) return;
        this.setBlockStatus('Zapisywanie bloku…');
        try {
            const res = await fetch(this.blocksUrlValue, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ name, w: Math.round(bb.w), h: Math.round(bb.h), preview: this.blockPreview(norm, bb.w, bb.h), els: norm }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd zapisu bloku.');
            await this.renderBlockPalette();
            this.statusTarget.textContent = 'Zapisano blok „' + name + '" do magazynu bloków.';
        } catch (e) {
            this.setBlockStatus('Błąd: ' + e.message, true);
        }
    }

    blockBBox(els) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const e of els) {
            x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
            x1 = Math.max(x1, e.x + (e.width || 0)); y1 = Math.max(y1, e.y + (e.height || 1));
        }
        return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    }

    /** Renderuje znormalizowane elementy (origin 0,0) do małego PNG (miniatura bloku). */
    blockPreview(els, w, h) {
        try {
            const K = this.Konva;
            const cont = document.createElement('div');
            const stage = new K.Stage({ container: cont, width: w, height: h });
            const layer = new K.Layer();
            stage.add(layer);
            layer.add(new K.Rect({ x: 0, y: 0, width: w, height: h, fill: '#ffffff' }));
            for (const el of els) { const n = this.buildNode(el, false); if (n) layer.add(n); }
            layer.draw();
            const pr = Math.min(2, 240 / Math.max(w, h));
            const url = stage.toDataURL({ pixelRatio: pr, mimeType: 'image/png' });
            stage.destroy();
            return url;
        } catch (e) { return ''; }
    }

    async renderBlockPalette() {
        const grid = this.element.querySelector('[data-block="grid"]');
        if (grid) grid.innerHTML = '';
        this.setBlockStatus('Wczytuję bloki…');
        try { await this.fetchBlocks(); }
        catch (e) { this.setBlockStatus('Błąd: ' + e.message, true); return; }
        this.renderBlockGrid();
    }

    renderBlockGrid() {
        const grid = this.element.querySelector('[data-block="grid"]');
        if (!grid || !this._blocks) return;
        if (!this._blocks.length) {
            grid.innerHTML = '';
            this.setBlockStatus('Brak zapisanych bloków. Zaznacz elementy na stronie i kliknij „Zapisz zaznaczenie jako blok".');
            return;
        }
        this.setBlockStatus(this._blocks.length + ' bloków — kliknij, by wstawić na bieżącą stronę (jako gotową grupę).');
        const frag = document.createDocumentFragment();
        for (const b of this._blocks) {
            const col = document.createElement('div');
            col.className = 'col';
            const wrap = document.createElement('div');
            wrap.className = 'gz-media-item';
            const ins = document.createElement('button');
            ins.type = 'button';
            ins.className = 'btn btn-outline-secondary w-100 p-1 d-flex flex-column align-items-center';
            ins.title = b.name + ' · ' + (b.count || b.els.length) + ' el. · ' + b.w + '×' + b.h + ' pt';
            if (b.preview) { const img = document.createElement('img'); img.src = b.preview; img.className = 'gz-media-thumb'; ins.appendChild(img); }
            const cap = document.createElement('span');
            cap.className = 'small text-truncate w-100 mt-1';
            cap.style.maxWidth = '100%';
            cap.textContent = b.name;
            ins.appendChild(cap);
            ins.addEventListener('click', () => this.insertBlock(b.id));
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'btn btn-icon btn-sm btn-danger gz-media-del';
            del.title = 'Usuń blok';
            del.innerHTML = '<i class="ti ti-trash"></i>';
            del.addEventListener('click', (ev) => { ev.stopPropagation(); this.deleteBlock(b.id); });
            wrap.appendChild(ins); wrap.appendChild(del);
            col.appendChild(wrap);
            frag.appendChild(col);
        }
        grid.innerHTML = '';
        grid.appendChild(frag);
    }

    insertBlock(blockId) {
        const b = (this._blocks || []).find((x) => x.id === blockId);
        if (!b) return;
        const ox = Math.max(10, Math.round((this.pageW - b.w) / 2));
        const oy = 60;
        const gid = 'g_' + Math.random().toString(36).slice(2, 9);
        const block = this.cloneBlock(b.els, ox, oy, gid); // wstawiany jako JEDNA grupa
        for (const c of block) this.page().elements.push(c);
        this.selectAll(block.map((c) => c.id));
        const cb = document.querySelector('#gzBlocksModal [data-bs-dismiss="modal"]');
        if (cb) cb.click();
        this.statusTarget.textContent = 'Wstawiono blok „' + b.name + '" (jako grupa).';
    }

    async deleteBlock(blockId) {
        if (!confirm('Usunąć ten blok z magazynu?')) return;
        try {
            const res = await fetch(this.blocksUrlValue + '/' + blockId + '/delete', {
                method: 'POST',
                headers: { 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd usuwania.');
            this._blocks = (this._blocks || []).filter((x) => x.id !== blockId);
            this.renderBlockGrid();
        } catch (e) {
            this.setBlockStatus('Błąd: ' + e.message, true);
        }
    }

    // ─── Szablony startowe ──────────────────────────────────

    applyTemplate(e) {
        this.applyTemplateKey(e.params.key, true);
    }

    applyTemplateKey(key, confirmIfNotEmpty) {
        const els = this.buildTemplate(key);
        if (!els.length) return;
        if (confirmIfNotEmpty && this.page().elements.length
            && !confirm('Zastąpić zawartość bieżącej strony wybranym szablonem?')) {
            return;
        }
        this.page().elements = els;
        this.select(null);
        this.markDirty();
        this.renderPage();
    }

    // ─── SZABLONY UŻYTKOWNIKA (cała strona zapisana w bibliotece) ──────
    // (onTemplatesModalShow zdefiniowane niżej — przy savePageAsTemplate — żeby też podstawić smart-default w polu „Nazwa".)

    /** Stała etykieta dla braku kategorii — wspólna dla zakładek i chipów na kartach. */
    get _NO_CAT_LABEL() { return 'Bez kategorii'; }

    /** Pobiera listę i renderuje karty „Moje szablony" + zakładki kategorii. */
    async renderUserPageTemplates() {
        const grid = this.element.querySelector('[data-gz-page-tpls-grid]');
        const status = this.element.querySelector('[data-gz-page-tpls-status]');
        const cnt = this.element.querySelector('[data-gz-page-tpls-count]');
        const tabs = this.element.querySelector('[data-gz-page-tpls-tabs]');
        if (!grid || !status) { return; }
        status.textContent = 'Wczytywanie…';
        status.style.color = '';
        grid.innerHTML = '';
        if (tabs) { tabs.innerHTML = ''; }
        try {
            const res = await fetch(this.pageTemplatesUrlValue, { headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
            const data = await res.json();
            if (!data.ok) { throw new Error(data.error || 'Nie udało się wczytać szablonów.'); }
            this._pageTemplates = data.items || [];
            if (cnt) { cnt.textContent = this._pageTemplates.length ? '(' + this._pageTemplates.length + ')' : ''; }
            // Każdorazowo PRZY OTWARCIU modala (i po dodaniu szablonu) odśwież opcje selecta kategorii.
            this._buildCategorySelect();
            if (!this._pageTemplates.length) {
                status.textContent = '';
                const empty = document.createElement('div');
                empty.className = 'col-12';
                empty.innerHTML = '<div class="gz-ptpl__empty">Brak zapisanych szablonów. Wypełnij formularz powyżej i kliknij <strong>„Zapisz tę stronę"</strong>, by dodać pierwszy.</div>';
                grid.appendChild(empty);
                return;
            }
            status.textContent = 'Kliknij szablon, aby zastosować go na bieżącej stronie. Dwuklik na nazwę = zmień nazwę. Klik na chip kategorii = przenieś.';
            // Zbuduj zakładki (kategorie) i render kart.
            this._renderCategoryTabs();
            // Pierwsze otwarcie: zakładka „Wszystkie" aktywna.
            this._activeCategory = this._activeCategory ?? '__all__';
            // Jeśli aktywna kategoria przestała istnieć — wróć na „Wszystkie".
            if (this._activeCategory !== '__all__' && this._activeCategory !== '__none__'
                && !this._pageTemplates.some((x) => (x.category || '') === this._activeCategory)) {
                this._activeCategory = '__all__';
            }
            this._renderTemplateCards();
        } catch (e) {
            status.textContent = 'Błąd: ' + e.message;
            status.style.color = '#d63b3b';
        }
    }

    /** Buduje pasek zakładek z UNIKALNYCH kategorii (alfabetycznie) + „Wszystkie" na początku + „Bez kategorii" gdy są takie. */
    _renderCategoryTabs() {
        const tabs = this.element.querySelector('[data-gz-page-tpls-tabs]');
        if (!tabs) { return; }
        tabs.innerHTML = '';
        const list = this._pageTemplates || [];
        const counts = {};
        let noneCount = 0;
        for (const t of list) {
            const c = (t.category || '').trim();
            if (c) { counts[c] = (counts[c] || 0) + 1; }
            else { noneCount++; }
        }
        const cats = Object.keys(counts).sort((a, b) => a.localeCompare(b, 'pl'));
        const items = [{ key: '__all__', label: 'Wszystkie', count: list.length, icon: 'layout-grid' }];
        for (const c of cats) { items.push({ key: c, label: c, count: counts[c], icon: 'tag' }); }
        if (noneCount > 0) { items.push({ key: '__none__', label: this._NO_CAT_LABEL, count: noneCount, icon: 'folder' }); }
        for (const it of items) {
            const li = document.createElement('li');
            li.className = 'nav-item';
            const a = document.createElement('a');
            a.className = 'nav-link' + ((this._activeCategory ?? '__all__') === it.key ? ' active' : '');
            a.href = '#';
            a.dataset.cat = it.key;
            a.innerHTML = '<i class="ti ti-' + it.icon + '"></i><span>' + this._escapeHtml(it.label) + '</span><span class="gz-tab-cnt">' + it.count + '</span>';
            a.addEventListener('click', (e) => {
                e.preventDefault();
                this._activeCategory = it.key;
                tabs.querySelectorAll('.nav-link').forEach((x) => x.classList.remove('active'));
                a.classList.add('active');
                this._renderTemplateCards();
            });
            li.appendChild(a);
            tabs.appendChild(li);
        }
    }

    /** Buduje <select> kategorii: „— Bez kategorii —" + group „Twoje" + group „Sugestie" (tylko nieużywane) + „+ Nowa kategoria…". */
    _buildCategorySelect() {
        const sel = this.element.querySelector('[data-gz-save-tpl-category]');
        const newcatInp = this.element.querySelector('[data-gz-save-tpl-newcat]');
        if (!sel) { return; }

        const used = new Set();
        for (const t of (this._pageTemplates || [])) {
            const c = (t.category || '').trim();
            if (c) { used.add(c); }
        }
        const usedSorted = Array.from(used).sort((a, b) => a.localeCompare(b, 'pl'));
        const suggested  = ['Okładki', 'Artykuły', 'Fotorelacje', 'Wywiady', 'Stopki', 'Ogłoszenia', 'Quizy / Krzyżówki', 'Plakaty'];
        const sugSorted  = suggested.filter((s) => !used.has(s));

        const prev = sel.value;
        sel.innerHTML = '';

        const optNone = document.createElement('option');
        optNone.value = ''; optNone.textContent = '— Bez kategorii —';
        sel.appendChild(optNone);

        if (usedSorted.length) {
            const og = document.createElement('optgroup');
            og.label = 'Twoje kategorie';
            for (const c of usedSorted) {
                const o = document.createElement('option');
                o.value = c; o.textContent = c;
                og.appendChild(o);
            }
            sel.appendChild(og);
        }
        if (sugSorted.length) {
            const og = document.createElement('optgroup');
            og.label = 'Sugestie';
            for (const c of sugSorted) {
                const o = document.createElement('option');
                o.value = c; o.textContent = c;
                og.appendChild(o);
            }
            sel.appendChild(og);
        }

        const optNew = document.createElement('option');
        optNew.value = '__new__'; optNew.textContent = '+ Nowa kategoria…';
        sel.appendChild(optNew);

        // Pre-fill: 1) aktywna zakładka (jeśli konkretna), 2) poprzedni wybór jeśli wciąż istnieje, 3) puste.
        let preset = '';
        if (this._activeCategory && this._activeCategory !== '__all__' && this._activeCategory !== '__none__') {
            preset = this._activeCategory;
        } else if (prev && prev !== '__new__') {
            preset = prev;
        }
        if (preset && Array.from(sel.options).some((o) => o.value === preset)) {
            sel.value = preset;
        } else {
            sel.value = '';
        }
        if (newcatInp) { newcatInp.hidden = true; newcatInp.value = ''; }
    }

    /** Akcja Stimulus dla <select kategorii>: „+ Nowa…" → odsłania input tekstowy; inne wartości → chowa. */
    onCategorySelectChange(e) {
        const sel = e.target;
        const newcatInp = this.element.querySelector('[data-gz-save-tpl-newcat]');
        if (!newcatInp) { return; }
        if (sel.value === '__new__') {
            newcatInp.hidden = false;
            newcatInp.focus();
            // Reset selecta na puste — przy zapisie czytamy z inputa nowej kategorii.
            sel.value = '';
        } else {
            newcatInp.hidden = true;
            newcatInp.value = '';
        }
    }

    /** Renderuje karty PRZEFILTROWANE wg aktywnej zakładki. */
    _renderTemplateCards() {
        const grid = this.element.querySelector('[data-gz-page-tpls-grid]');
        if (!grid) { return; }
        grid.innerHTML = '';
        const filtered = (this._pageTemplates || []).filter((t) => {
            if (this._activeCategory === '__all__') { return true; }
            if (this._activeCategory === '__none__') { return !t.category; }
            return (t.category || '') === this._activeCategory;
        });
        if (!filtered.length) {
            const empty = document.createElement('div');
            empty.className = 'col-12';
            empty.innerHTML = '<div class="gz-ptpl__empty">Brak szablonów w tej zakładce.</div>';
            grid.appendChild(empty);
            return;
        }
        const frag = document.createDocumentFragment();
        for (const t of filtered) { frag.appendChild(this.makeUserTemplateCard(t)); }
        grid.appendChild(frag);
    }

    _escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    makeUserTemplateCard(t) {
        const col = document.createElement('div');
        col.className = 'col-6 col-md-4 col-lg-3';
        const card = document.createElement('div');
        card.className = 'gz-ptpl';
        card.dataset.id = String(t.id);
        card.dataset.category = t.category || '';

        // Plakietka z rozmiarem strony (informuje o ewentualnej różnicy A5/A4)
        const size = document.createElement('span');
        size.className = 'gz-ptpl__sizebadge';
        const mine = (t.pageW === this.pageW && t.pageH === this.pageH);
        size.textContent = (mine ? '' : '≠ ') + t.pageW + '×' + t.pageH + ' pt';
        if (!mine) { size.title = 'Szablon zapisano na innym rozmiarze strony — elementy mogą wymagać dopasowania.'; size.style.color = '#9b6e00'; size.style.background = '#fff7d6'; size.style.borderColor = '#f5b800'; }
        card.appendChild(size);

        // Chip kategorii (klik = zmień kategorię)
        const cat = document.createElement('span');
        cat.className = 'gz-ptpl__cat' + (t.category ? '' : ' gz-ptpl__cat--none');
        cat.textContent = t.category || this._NO_CAT_LABEL;
        cat.title = 'Zmień kategorię (zakładkę)';
        cat.addEventListener('click', (e) => { e.stopPropagation(); this.promptChangeCategory(t, cat); });
        card.appendChild(cat);

        // Miniatura (klik = zastosuj)
        const thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className = 'btn p-0 border-0 gz-ptpl__thumb';
        thumb.title = 'Zastosuj szablon „' + t.name + '" na bieżącej stronie';
        if (t.preview) {
            const img = document.createElement('img');
            img.src = t.preview; img.alt = t.name;
            thumb.appendChild(img);
        } else {
            thumb.innerHTML = '<i class="ti ti-layout-grid text-secondary" style="font-size:2rem;"></i>';
        }
        thumb.addEventListener('click', () => this.applyUserTemplate(t.id));
        card.appendChild(thumb);

        // Nazwa (klik = edycja inline; Enter zatwierdza, Esc anuluje)
        const name = document.createElement('div');
        name.className = 'gz-ptpl__name';
        name.textContent = t.name;
        name.title = 'Kliknij dwukrotnie, aby zmienić nazwę';
        name.addEventListener('dblclick', () => this.startTemplateRename(name, t));
        card.appendChild(name);

        // Meta (liczba elementów + data)
        const meta = document.createElement('div');
        meta.className = 'gz-ptpl__meta';
        const created = t.createdAt ? new Date(t.createdAt).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
        meta.innerHTML = '<span>' + (t.count || 0) + ' elem.</span><span>' + created + '</span>';
        card.appendChild(meta);

        // Przyciski
        const btns = document.createElement('div');
        btns.className = 'gz-ptpl__btns';
        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = 'btn btn-sm btn-primary gz-ptpl__use';
        useBtn.innerHTML = '<i class="ti ti-check me-1"></i>Użyj';
        useBtn.addEventListener('click', () => this.applyUserTemplate(t.id));
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-sm btn-outline-danger';
        delBtn.title = 'Usuń szablon';
        delBtn.innerHTML = '<i class="ti ti-trash"></i>';
        delBtn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteUserTemplate(t.id); });
        btns.appendChild(useBtn);
        btns.appendChild(delBtn);
        card.appendChild(btns);

        col.appendChild(card);
        return col;
    }

    startTemplateRename(nameEl, t) {
        nameEl.contentEditable = 'true';
        nameEl.focus();
        // zaznacz całość
        const range = document.createRange(); range.selectNodeContents(nameEl);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        const cleanup = (commit) => {
            nameEl.contentEditable = 'false';
            window.removeEventListener('mousedown', outsideHandler, true);
            nameEl.removeEventListener('keydown', keyHandler);
            if (commit) {
                const newName = (nameEl.textContent || '').trim().slice(0, 120) || t.name;
                if (newName !== t.name) { this.renameUserTemplate(t.id, newName, nameEl); }
                else { nameEl.textContent = t.name; }
            } else {
                nameEl.textContent = t.name;
            }
        };
        const keyHandler = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
            else if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
        };
        const outsideHandler = (e) => { if (!nameEl.contains(e.target)) { cleanup(true); } };
        nameEl.addEventListener('keydown', keyHandler);
        setTimeout(() => window.addEventListener('mousedown', outsideHandler, true), 0);
    }

    async renameUserTemplate(id, name, nameEl) {
        try {
            const res = await fetch(this.pageTemplatesUrlValue + '/' + id + '/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ name }),
            });
            const data = await res.json();
            if (!data.ok) { throw new Error(data.error || 'Błąd zmiany nazwy.'); }
            // odśwież cache + UI
            const t = (this._pageTemplates || []).find((x) => x.id === id);
            if (t) { t.name = data.name; }
            if (nameEl) { nameEl.textContent = data.name; }
        } catch (e) {
            if (nameEl) { nameEl.textContent = ((this._pageTemplates || []).find((x) => x.id === id) || {}).name || ''; }
            this.statusTarget.textContent = 'Błąd: ' + e.message;
        }
    }

    /** Pyta o nową kategorię (autocomplete = lista użytych + sugestie) i zapisuje. */
    async promptChangeCategory(t, chipEl) {
        // Lista istniejących kategorii usera + nasze sugestie — uniknięcie literówek.
        const existing = new Set((this._pageTemplates || []).map((x) => (x.category || '').trim()).filter(Boolean));
        const suggested = ['Okładki', 'Artykuły', 'Fotorelacje', 'Wywiady', 'Stopki', 'Ogłoszenia', 'Quizy / Krzyżówki', 'Plakaty'];
        for (const s of suggested) { existing.add(s); }
        const list = Array.from(existing).sort((a, b) => a.localeCompare(b, 'pl'));
        const hint = list.length ? '\n\nIstniejące: ' + list.join(' · ') : '';
        const raw = prompt('Kategoria (zakładka) dla szablonu „' + t.name + '"\n(puste = bez kategorii)' + hint, t.category || '');
        if (raw === null) { return; } // anuluj
        const newCat = raw.trim().slice(0, 60) || null;
        if ((newCat || '') === (t.category || '')) { return; }
        try {
            const res = await fetch(this.pageTemplatesUrlValue + '/' + t.id + '/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ category: newCat }),
            });
            const data = await res.json();
            if (!data.ok) { throw new Error(data.error || 'Błąd zapisu kategorii.'); }
            // odśwież cache + przebuduj zakładki/karty (zmiana zakładki może zmienić widoczność karty).
            t.category = data.category;
            if (chipEl) {
                chipEl.textContent = data.category || this._NO_CAT_LABEL;
                chipEl.classList.toggle('gz-ptpl__cat--none', !data.category);
            }
            this._renderCategoryTabs();
            this._renderTemplateCards();
            this.statusTarget.textContent = 'Przeniesiono do kategorii: ' + (data.category || this._NO_CAT_LABEL);
        } catch (e) {
            this.statusTarget.textContent = 'Błąd: ' + e.message;
        }
    }

    async deleteUserTemplate(id) {
        const t = (this._pageTemplates || []).find((x) => x.id === id);
        if (!t || !confirm('Usunąć szablon „' + t.name + '"?')) { return; }
        try {
            const res = await fetch(this.pageTemplatesUrlValue + '/' + id + '/delete', {
                method: 'POST',
                headers: { 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
            });
            const data = await res.json();
            if (!data.ok) { throw new Error(data.error || 'Błąd usuwania.'); }
            this._pageTemplates = (this._pageTemplates || []).filter((x) => x.id !== id);
            this.renderUserPageTemplates();
            this.statusTarget.textContent = 'Usunięto szablon.';
        } catch (e) {
            this.statusTarget.textContent = 'Błąd: ' + e.message;
        }
    }

    /** Klon elementów szablonu, świeże ID-ki + grupy (żeby nie kolidowały z istniejącymi). */
    cloneTemplateElements(els) {
        const idMap = {};
        const groupMap = {};
        const out = [];
        for (const src of els) {
            const c = JSON.parse(JSON.stringify(src));
            const oldId = c.id;
            c.id = uid();
            if (oldId) { idMap[oldId] = c.id; }
            if (c.groupId) {
                if (!groupMap[c.groupId]) { groupMap[c.groupId] = 'g_' + Math.random().toString(36).slice(2, 9); }
                c.groupId = groupMap[c.groupId];
            }
            out.push(c);
        }
        return out;
    }

    async applyUserTemplate(id) {
        const t = (this._pageTemplates || []).find((x) => x.id === id);
        if (!t) { return; }

        const hasContent = this.page().elements.length > 0;
        if (hasContent) {
            const ok = confirm('Zastąpić zawartość bieżącej strony szablonem „' + t.name + '"?\n\n(Jeśli wolisz zostawić obecną stronę i wstawić szablon jako NOWĄ — anuluj i użyj „Strona → Duplikuj/Nowa".)');
            if (!ok) { return; }
        }

        // Ostrzeżenie o niezgodnym rozmiarze (np. szablon A5 → strona A4)
        if (t.pageW && t.pageH && (t.pageW !== this.pageW || t.pageH !== this.pageH)) {
            const useScale = confirm(
                'Szablon ma rozmiar ' + t.pageW + '×' + t.pageH + ' pt, a bieżąca strona ' + this.pageW + '×' + this.pageH + ' pt.\n\n'
                + 'OK = przeskaluj proporcjonalnie do bieżącej strony\n'
                + 'Anuluj = wstaw bez skalowania (jak zapisano)'
            );
            const els = this.cloneTemplateElements(t.elements || []);
            if (useScale) {
                const sx = this.pageW / t.pageW;
                const sy = this.pageH / t.pageH;
                const s  = Math.min(sx, sy); // uniform — nie zniekształca
                for (const e of els) {
                    e.x = (e.x || 0) * s;
                    e.y = (e.y || 0) * s;
                    if (e.width)  { e.width  = Math.max(4, e.width  * s); }
                    if (e.height) { e.height = Math.max(4, e.height * s); }
                    if (typeof e.fontSize === 'number')      { e.fontSize      *= s; }
                    if (typeof e.strokeWidth === 'number')   { e.strokeWidth   *= s; }
                    if (typeof e.cornerRadius === 'number')  { e.cornerRadius  *= s; }
                    if (typeof e.padding === 'number')       { e.padding       *= s; }
                    if (typeof e.bgRadius === 'number')      { e.bgRadius      *= s; }
                    if (typeof e.borderWidth === 'number')   { e.borderWidth   *= s; }
                    // letterSpacing / lineHeight / wrapGap zostawiamy (mnożniki / nie zauważalne na małej skali)
                }
            }
            this.page().elements = els;
        } else {
            this.page().elements = this.cloneTemplateElements(t.elements || []);
        }

        if (t.background) { this.page().background = t.background; }
        this.select(null);
        this.markDirty();
        this.renderPage();
        this.statusTarget.textContent = 'Zastosowano szablon „' + t.name + '".';

        // Domknij modal po pomyślnym zastosowaniu (po confirm-ach, nie wcześniej — żeby modal nie znikał za pytaniem).
        const modalEl = document.getElementById('gzTemplatesModal');
        if (modalEl && window.bootstrap && window.bootstrap.Modal) {
            const inst = window.bootstrap.Modal.getInstance(modalEl);
            if (inst) { inst.hide(); }
        }
    }

    /** Renderuje BIEŻĄCĄ stronę na off-screen Stage i zwraca data-URI miniatury PNG (~240 px największy bok). */
    pageThumbnail(maxSide = 240) {
        try {
            const K = this.Konva;
            const cont = document.createElement('div');
            const stage = new K.Stage({ container: cont, width: this.pageW, height: this.pageH });
            const layer = new K.Layer();
            stage.add(layer);
            layer.add(new K.Rect({ x: 0, y: 0, width: this.pageW, height: this.pageH, fill: this.page().background || '#ffffff' }));
            for (const el of this.page().elements) {
                try { const n = this.buildNode(el, false); if (n) layer.add(n); }
                catch (_) { /* pojedynczy zły element nie psuje miniatury */ }
            }
            layer.draw();
            const pr = Math.min(2, maxSide / Math.max(this.pageW, this.pageH));
            const url = stage.toDataURL({ pixelRatio: pr, mimeType: 'image/jpeg', quality: 0.82 });
            stage.destroy();
            return url;
        } catch (e) { return ''; }
    }

    /** Zapis BIEŻĄCEJ strony jako szablon (z miniaturą). Czyta nazwę + kategorię z mini-formularza w modalu. */
    async savePageAsTemplate() {
        const els = this.page().elements || [];
        if (!els.length) {
            this.statusTarget.textContent = 'Pusta strona — nie ma czego zapisać.';
            return;
        }
        const nameInp = this.element.querySelector('[data-gz-save-tpl-name]');
        const catSel  = this.element.querySelector('[data-gz-save-tpl-category]');
        const newcatInp = this.element.querySelector('[data-gz-save-tpl-newcat]');
        let name = (nameInp && nameInp.value || '').trim();
        if (!name) { name = this.suggestTemplateName(els); }
        if (!name) { return; }
        // Kategoria: 1) input „nowa kategoria" jeśli widoczny+wypełniony, 2) wybór z selecta,
        // 3) aktualnie otwarta zakładka (jeśli konkretna), 4) pusto.
        let category = '';
        if (newcatInp && !newcatInp.hidden && newcatInp.value.trim()) {
            category = newcatInp.value.trim().slice(0, 60);
        } else if (catSel && catSel.value && catSel.value !== '__new__') {
            category = catSel.value.trim();
        } else if (this._activeCategory && this._activeCategory !== '__all__' && this._activeCategory !== '__none__') {
            category = this._activeCategory;
        }

        this.statusTarget.textContent = 'Zapisywanie szablonu…';
        try {
            const snapshot = JSON.parse(JSON.stringify(els));
            const preview = this.pageThumbnail(260);
            const res = await fetch(this.pageTemplatesUrlValue, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({
                    name,
                    category: category || null,
                    pageW: this.pageW,
                    pageH: this.pageH,
                    background: this.page().background || null,
                    preview,
                    elements: snapshot,
                }),
            });
            const data = await res.json();
            if (!data.ok) { throw new Error(data.error || 'Błąd zapisu szablonu.'); }
            this.statusTarget.textContent = 'Zapisano szablon „' + name + '"' + (data.category ? ' (' + data.category + ')' : '') + '.';
            // Wyczyść inputy formularza po sukcesie.
            if (nameInp) { nameInp.value = ''; }
            if (newcatInp) { newcatInp.hidden = true; newcatInp.value = ''; }
            // Kategorię ZOSTAW pre-wybraną w selectcie (po przebudowie w renderUserPageTemplates
            // → _buildCategorySelect zsynchronizuje wartość z _activeCategory).
            // Po zapisie: przeskocz na zakładkę, do której trafił szablon (komfort).
            this._activeCategory = data.category || '__none__';
            const modalEl = document.getElementById('gzTemplatesModal');
            if (modalEl && modalEl.classList.contains('show')) { this.renderUserPageTemplates(); }
        } catch (e) {
            this.statusTarget.textContent = 'Błąd: ' + e.message;
        }
    }

    /** Smart-default w polu „Nazwa" przy otwarciu modala — gdy jest pusty. */
    onTemplatesModalShow() {
        const nameInp = this.element.querySelector('[data-gz-save-tpl-name]');
        if (nameInp && !nameInp.value && (this.page().elements || []).length) {
            nameInp.value = this.suggestTemplateName(this.page().elements);
        }
        this.renderUserPageTemplates();
    }

    /** Podpowiada nazwę szablonu na podstawie zawartości strony (pierwszy nagłówkowy tekst, fallback do daty). */
    suggestTemplateName(els) {
        // największy tekst = prawdopodobnie nagłówek
        let best = null;
        for (const e of els) {
            if (e.type !== 'text' || !e.text) { continue; }
            const size = e.fontSize || 14;
            if (!best || size > (best.fontSize || 14)) { best = e; }
        }
        const txt = best ? String(best.text).split(/\s+/).slice(0, 5).join(' ').slice(0, 60) : '';
        if (txt) { return 'Szablon: ' + txt; }
        const d = new Date();
        return 'Strona ' + (this.current + 1) + ' (' + d.toLocaleDateString('pl-PL') + ')';
    }

    /** Zwraca gotowy zestaw elementów dla danego szablonu (współrzędne w pt). */
    buildTemplate(key) {
        const W = this.pageW, H = this.pageH, m = 36, cw = W - 2 * m;
        const base = (o) => Object.assign({ id: uid(), rotation: 0, opacity: 1 }, o);
        const text = (o) => base(Object.assign({
            type: 'text', fontFamily: 'Georgia', fontStyle: 'normal', fill: '#1a2330',
            align: 'left', lineHeight: 1.3, columns: 1, columnGap: 14,
        }, o));
        const rect = (o) => base(Object.assign({ type: 'rect', fill: '#e9eef5', stroke: null, strokeWidth: 0, cornerRadius: 4 }, o));
        const line = (o) => base(Object.assign({ type: 'line', stroke: '#1a2330', strokeWidth: 2 }, o));
        const photo = (x, y, w, h, label) => ([
            rect({ x, y, width: w, height: h, fill: '#eef1f5', cornerRadius: 4 }),
            text({
                x, y: y + h / 2 - 9, width: w, height: 20, text: label || 'Wstaw zdjęcie',
                align: 'center', fill: '#9aa3af', fontFamily: 'Arial', fontSize: 11,
            }),
        ]);
        const now = new Date();
        const months = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
        const issue = `${months[now.getMonth()]} ${now.getFullYear()}`;

        switch (key) {
            case 'cover':
                return [
                    line({ x: m, y: 48, width: cw, height: 0, strokeWidth: 3, stroke: '#0b1f3a' }),
                    text({ x: m, y: 56, width: cw, height: 56, text: 'NAZWA GAZETKI', align: 'center', fontStyle: 'bold', fontSize: 34, fill: '#0b1f3a', lineHeight: 1.05 }),
                    text({ x: m, y: 118, width: cw, height: 20, text: 'Gazetka szkolna · Nr 1 · ' + issue, align: 'center', fontSize: 12, fill: '#5b6675', fontFamily: 'Arial' }),
                    line({ x: m, y: 144, width: cw, height: 0, strokeWidth: 1, stroke: '#c7ced6' }),
                    ...photo(m, 160, cw, 248, 'Zdjęcie na okładkę'),
                    text({ x: m, y: 424, width: cw, height: 24, text: 'W tym numerze:', fontStyle: 'bold', fontSize: 15, fill: '#0b1f3a' }),
                    text({ x: m, y: 450, width: cw, height: 110, fontSize: 13, lineHeight: 1.55, text: '• Wywiad z dyrektorem szkoły\n• Relacja z wycieczki klasowej\n• Kącik literacki — nasze wiersze\n• Sport i wydarzenia' }),
                ];

            case 'article2col':
                return [
                    text({ x: m, y: 40, width: cw, height: 42, text: 'Tytuł artykułu', fontStyle: 'bold', fontSize: 24, fill: '#0b1f3a', lineHeight: 1.1 }),
                    text({ x: m, y: 84, width: cw, height: 16, text: 'Autor: Imię Nazwisko · klasa', fontSize: 10, fontFamily: 'Arial', fill: '#6b7480' }),
                    line({ x: m, y: 106, width: cw, height: 0, strokeWidth: 1, stroke: '#c7ced6' }),
                    text({ x: m, y: 118, width: cw, height: 441, columns: 2, fontSize: 11.5, lineHeight: 1.4, align: 'justify', text: LOREM_PL }),
                ];

            case 'article1col':
                return [
                    text({ x: m, y: 40, width: cw, height: 42, text: 'Tytuł artykułu', fontStyle: 'bold', fontSize: 24, fill: '#0b1f3a', lineHeight: 1.1 }),
                    ...photo(m, 92, cw, 180, 'Zdjęcie do artykułu'),
                    text({ x: m, y: 286, width: cw, height: 16, text: 'Podpis pod zdjęciem', fontSize: 9, fontStyle: 'italic', fontFamily: 'Arial', fill: '#8a929c' }),
                    text({ x: m, y: 310, width: cw, height: 249, columns: 1, fontSize: 12.5, lineHeight: 1.45, align: 'justify', text: LOREM_PL }),
                ];

            case 'photopage': {
                const gap = 16;
                const cellW = (cw - gap) / 2;
                const imgH = 168;
                const r1 = 86, r2 = r1 + imgH + 38;
                const cap = (x, y, w) => text({ x, y, width: w, height: 16, text: 'Podpis zdjęcia', fontSize: 9, fontStyle: 'italic', fontFamily: 'Arial', fill: '#8a929c', align: 'center' });
                return [
                    text({ x: m, y: 40, width: cw, height: 34, text: 'Fotorelacja', fontStyle: 'bold', fontSize: 22, fill: '#0b1f3a' }),
                    ...photo(m, r1, cellW, imgH), cap(m, r1 + imgH + 4, cellW),
                    ...photo(m + cellW + gap, r1, cellW, imgH), cap(m + cellW + gap, r1 + imgH + 4, cellW),
                    ...photo(m, r2, cellW, imgH), cap(m, r2 + imgH + 4, cellW),
                    ...photo(m + cellW + gap, r2, cellW, imgH), cap(m + cellW + gap, r2 + imgH + 4, cellW),
                ];
            }

            case 'colophon':
                return [
                    text({ x: m, y: 40, width: cw, height: 32, text: 'Stopka redakcyjna', fontStyle: 'bold', fontSize: 20, fill: '#0b1f3a' }),
                    line({ x: m, y: 78, width: cw, height: 0, strokeWidth: 1, stroke: '#c7ced6' }),
                    text({ x: m, y: 96, width: cw, height: 300, fontSize: 12.5, lineHeight: 1.6, text: 'Gazetkę przygotował zespół redakcyjny:\n\nRedaktor naczelny: …\nRedakcja: …\nOpiekun: …\nSkład i grafika: …\n\nDziękujemy wszystkim, którzy pomogli przy tym numerze.\n\nKontakt: redakcja@szkola.pl' }),
                ];

            default:
                return [];
        }
    }

    // ─── Właściwości ────────────────────────────────────────

    syncProps() {
        const panel = this.propsTarget;
        const allSel = this.selectedElements();
        const multi = allSel.length > 1;
        // Bulk-edit dostępne gdy WSZYSTKIE zaznaczone elementy są tego SAMEGO typu.
        // Wtedy pierwszy z nich służy jako reprezentant wartości w panelu,
        // a onPropInput zaaplikuje zmianę do każdego z listy.
        const allSameType = multi && allSel.every((e) => e.type === allSel[0].type);
        const el = (multi && allSameType) ? allSel[0] : this.selectedEl();

        panel.querySelectorAll('[data-for]').forEach((group) => {
            const types = group.dataset.for.split(' ');
            const show = el && (types.includes('any') || types.includes(el.type));
            group.style.display = show ? '' : 'none';
        });
        // Panel selekcji wielokrotnej (grupowanie / blok / bulk-edit).
        const mp = panel.querySelector('[data-multi]');
        if (mp) {
            mp.style.display = multi ? '' : 'none';
            if (multi) {
                const cnt = mp.querySelector('[data-multi-count]');
                if (cnt) cnt.textContent = this.selectedIds.length;
                const grouped = allSel.some((e) => e.groupId);
                const gb = mp.querySelector('[data-act="group"]'), ub = mp.querySelector('[data-act="ungroup"]');
                if (gb) gb.disabled = false;
                if (ub) ub.disabled = !grouped;
                // Wskaźnik trybu edycji zbiorczej (gdy wszystkie tego samego typu).
                const bulkBox = mp.querySelector('[data-multi-bulk]');
                if (bulkBox) {
                    bulkBox.style.display = allSameType ? '' : 'none';
                    if (allSameType) {
                        const bc = mp.querySelector('[data-multi-bulk-count]');
                        const bt = mp.querySelector('[data-multi-bulk-type]');
                        if (bc) bc.textContent = allSel.length;
                        if (bt) {
                            const typeLabels = { text: 'tekst', image: 'obraz', icon: 'ikona', rect: 'prostokąt', line: 'linia' };
                            bt.textContent = typeLabels[allSel[0].type] || allSel[0].type;
                        }
                    }
                }
            }
        }
        panel.querySelector('[data-empty]')?.style.setProperty('display', (el || multi) ? 'none' : '');

        if (!el) return;
        panel.querySelectorAll('[data-prop]').forEach((input) => {
            const key = input.dataset.prop;
            const has = el[key] !== undefined;
            if (input.type === 'checkbox') { input.checked = has ? !!el[key] : false; }
            else if (input.type === 'color') {
                // `<input type=color>` nie akceptuje "" — daj fallback na czarny gdy brak wartości.
                const v = has && /^#[0-9a-fA-F]{6}$/.test(String(el[key])) ? el[key] : '#000000';
                input.value = v;
            }
            else if (input.dataset.type === 'percent') {
                // Pole przechowuje 0–1 (np. opacity), w UI pokazujemy 0–100%.
                const v = has ? (el[key] * 100) : 100;
                input.value = String(Math.round(v));
            }
            else { input.value = has ? el[key] : ''; }
        });
        // Live label dla krycia (% obok suwaka).
        const opLbl = panel.querySelector('[data-opacity-label]');
        if (opLbl) { opLbl.textContent = Math.round(((el.opacity != null ? el.opacity : 1) * 100)) + '%'; }
        // Widoczność pól gradientu w panelu rect
        if (el.type === 'rect') {
            this._syncGradVisibility(panel, '[data-grad-if]', el.gradientType, el.gradientAngle, '[data-grad-angle-label]');
        }
        // Widoczność pól gradientu tła tekstu
        if (el.type === 'text') {
            this._syncGradVisibility(panel, '[data-bgrad-if]', el.bgGradientType, el.bgGradientAngle, '[data-bgrad-angle-label]');
        }
        // Widoczność pól zależnych od kształtu ramki obrazu (np. zaokrąglenie rogów tylko dla rect).
        if (el.type === 'image') {
            const fsh = el.frameShape || 'rect';
            panel.querySelectorAll('[data-frameshape-if]').forEach((node) => {
                node.style.display = (node.dataset.frameshapeIf === fsh) ? '' : 'none';
            });
            // Widoczność pól zależnych od stylu krawędzi (slider intensywności pokazujemy tylko dla styli != 'none').
            const fst = el.frameStyle || 'none';
            panel.querySelectorAll('[data-framestyle-if]').forEach((node) => {
                const cond = node.dataset.framestyleIf;
                let show;
                if (cond === 'not-none') { show = (fst !== 'none'); }
                else { show = (cond === fst); }
                node.style.display = show ? '' : 'none';
            });
            // Live label dla intensywności (% obok suwaka).
            const inLbl = panel.querySelector('[data-framestyle-intensity-label]');
            const inInp = panel.querySelector('[data-prop="frameStyleIntensity"]');
            const intV = (el.frameStyleIntensity != null) ? el.frameStyleIntensity : 50;
            if (inInp && inInp.value === '') { inInp.value = String(intV); }
            if (inLbl) { inLbl.textContent = Math.round(intV) + '%'; }
        }
    }

    /** Wspólna logika widoczności pól: solid/gradient/linear/radial + label kąta. */
    _syncGradVisibility(panel, selector, type, angle, angleLabelSelector) {
        const isGrad = (type === 'linear' || type === 'radial');
        panel.querySelectorAll(selector).forEach((node) => {
            const flag = node.dataset[selector === '[data-grad-if]' ? 'gradIf' : 'bgradIf'];
            let show = false;
            if (flag === 'solid') { show = !isGrad; }
            else if (flag === 'gradient') { show = isGrad; }
            else if (flag === 'linear') { show = (type === 'linear'); }
            else if (flag === 'radial') { show = (type === 'radial'); }
            node.style.display = show ? '' : 'none';
        });
        const lbl = panel.querySelector(angleLabelSelector);
        if (lbl) { lbl.textContent = (angle || 0) + '°'; }
    }

    onPropInput(e) {
        const input = e.target.closest('[data-prop]');
        if (!input) return;

        // Bulk-edit: gdy wszystkie zaznaczone są tego SAMEGO typu, aplikujemy zmianę do każdego.
        // Inaczej działamy na pojedynczym selectedEl (jak dotąd).
        const allSel = this.selectedElements();
        const multiSame = allSel.length > 1 && allSel.every((e) => e.type === allSel[0].type);
        const targets = multiSame ? allSel : (this.selectedEl() ? [this.selectedEl()] : []);
        if (!targets.length) return;

        const key = input.dataset.prop;
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (input.dataset.type === 'number') value = parseFloat(value) || 0;
        else if (input.dataset.type === 'percent') {
            // UI: 0–100, w danych: 0–1.
            const p = parseFloat(value);
            value = Number.isFinite(p) ? Math.max(0, Math.min(1, p / 100)) : 1;
            // Aktualizacja live label (np. obok suwaka krycia).
            const opLbl = this.propsTarget.querySelector('[data-opacity-label]');
            if (opLbl && key === 'opacity') { opLbl.textContent = Math.round(value * 100) + '%'; }
        }

        // W trybie bulk pomijamy klucze, które przy aplikacji na wszystkie dałyby bezsensowny wynik:
        // - 'text' (nadpisałoby wszystkie treści tym samym),
        // - 'x' / 'y' (wszystkie wylądowałyby w jednym punkcie).
        const skipInBulk = new Set(['text', 'x', 'y']);
        const effTargets = (multiSame && skipInBulk.has(key)) ? [targets[0]] : targets;

        for (const el of effTargets) {
            el[key] = value;
            // Edycja zwykłego tekstu w panelu zastępuje całość — kasujemy formatowanie fragmentów (runs).
            if (key === 'text') { delete el.runs; delete el.paraAlign; }
            // Globalna zmiana czcionki musi „przebić" per-fragment overrides w runs.
            if (el.type === 'text' && Array.isArray(el.runs) && el.runs.length) {
                if (key === 'fontSize') { for (const r of el.runs) { delete r.s; } }
                else if (key === 'fill') { for (const r of el.runs) { delete r.c; } }
            }
            // Domyślne wartości gradientu prostokąta — per-element (każdy może mieć inny fill).
            if (el.type === 'rect' && key === 'gradientType' && (value === 'linear' || value === 'radial')) {
                if (!el.gradientFrom) { el.gradientFrom = el.fill || '#ffd400'; }
                if (!el.gradientTo)   { el.gradientTo = '#1a56db'; }
                if (el.gradientAngle == null) { el.gradientAngle = (value === 'linear') ? 90 : 0; }
            }
            // Domyślne wartości gradientu tła tekstu — per-element.
            if (el.type === 'text' && key === 'bgGradientType' && (value === 'linear' || value === 'radial')) {
                if (!el.bgFill && !el.bgGradientFrom) { el.bgFill = '#ffe08a'; }
                if (!el.bgGradientFrom) { el.bgGradientFrom = el.bgFill || '#ffd400'; }
                if (!el.bgGradientTo)   { el.bgGradientTo = '#ff6b3a'; }
                if (el.bgGradientAngle == null) { el.bgGradientAngle = (value === 'linear') ? 90 : 0; }
            }
            // Ikona: zmiana koloru/wypełnienia → przebuduj SVG.
            if (el.type === 'icon' && (key === 'iconColor' || key === 'iconFill' || key === 'iconFilled')) {
                this.regenIconSrc(el);
            }
        }

        // Akcje wykonywane raz, na pierwszym elemencie (UI/labels) — typ taki sam dla wszystkich w bulk.
        const firstEl = effTargets[0];

        if (firstEl.type === 'image' && key === 'keepRatio') {
            this.reattachTransformer();
        }
        if (firstEl.type === 'image' && (key === 'frameStyle' || key === 'frameStyleIntensity')) {
            this.syncProps();
        }
        if (firstEl.type === 'image' && key === 'frameShape') {
            // „custom" wymaga ścieżki punktów — gdy brak na pierwszym, wejdź w tryb rysowania (na nim).
            if (value === 'custom' && !(Array.isArray(firstEl.customPath) && firstEl.customPath.length >= 3)) {
                for (const el of effTargets) {
                    el.frameShape = (this._lastFrameShape && this._lastFrameShape !== 'custom') ? this._lastFrameShape : 'rect';
                }
                this.startCustomShapeDrawing(firstEl);
                return;
            }
            this._lastFrameShape = value;
            this.syncProps();
        }
        if (firstEl.type === 'rect' && key === 'gradientType') { this.syncProps(); }
        if (firstEl.type === 'rect' && key === 'gradientAngle') {
            const lbl = this.propsTarget.querySelector('[data-grad-angle-label]');
            if (lbl) { lbl.textContent = (firstEl.gradientAngle || 0) + '°'; }
        }
        if (firstEl.type === 'text' && key === 'bgGradientType') { this.syncProps(); }
        if (firstEl.type === 'text' && key === 'bgGradientAngle') {
            const lbl = this.propsTarget.querySelector('[data-bgrad-angle-label]');
            if (lbl) { lbl.textContent = (firstEl.bgGradientAngle || 0) + '°'; }
        }

        this.markDirty();
        // renderPage() ponownie podpina transformer wg selectedId.
        // NIE wołamy select()/syncProps — inaczej pole „Treść" traci pozycję kursora przy pisaniu.
        this.renderPage();

        // Zmiana czcionki: doładuj font (Google) i przerysuj, gdy będzie gotowy.
        if (key === 'fontFamily' && document.fonts && document.fonts.load) {
            document.fonts.load('16px "' + value + '"').then(() => this.renderPage()).catch(() => {});
        }
    }

    setBackground(e) {
        this.page().background = e.target.value;
        this.markDirty();
        this.renderPage();
    }

    // ─── Strony ─────────────────────────────────────────────

    // ─── Pływające okienka (palety) — drag + collapse + persist ──────────

    /** Włącza dragowanie, zwijanie i odtwarza zapisaną pozycję/widoczność panelu. */
    initFloatingPanel(panel, storageKey) {
        const k = (s) => 'gz.panel.' + storageKey + '.' + s;
        // odtworzenie stanu
        try {
            const x = parseFloat(localStorage.getItem(k('x')));
            const y = parseFloat(localStorage.getItem(k('y')));
            if (Number.isFinite(x) && Number.isFinite(y)) {
                this.placeFloating(panel, x, y);
            } else {
                // domyślnie prawy-górny róg, pod paskiem narzędzi
                this.placeFloating(panel, window.innerWidth - 280, 110);
            }
            if (localStorage.getItem(k('hidden')) !== '1') { panel.hidden = false; }
            if (localStorage.getItem(k('collapsed')) === '1') { panel.classList.add('gz-float--collapsed'); }
        } catch (_) { /* localStorage niedostępne */ }
        this.reflectLayersBtn();

        // drag
        const head = panel.querySelector('[data-float-drag]');
        if (head) {
            head.addEventListener('mousedown', (e) => {
                // ignoruj klik w przyciski w nagłówku — ale tylko w obrębie samego nagłówka
                // (NIE 'closest([data-action])' — to złapałoby cały panel, który ma data-action na liście warstw)
                if (e.button !== 0) { return; } // tylko lewy przycisk
                let n = e.target;
                while (n && n !== head) {
                    if (n.tagName === 'BUTTON' || n.hasAttribute('data-float-collapse')) { return; }
                    n = n.parentElement;
                }
                e.preventDefault();
                const startX = e.clientX, startY = e.clientY;
                const r = panel.getBoundingClientRect();
                const ox = r.left, oy = r.top;
                panel.classList.add('gz-float--dragging');
                const move = (ev) => {
                    const nx = ox + (ev.clientX - startX);
                    const ny = oy + (ev.clientY - startY);
                    this.placeFloating(panel, nx, ny);
                };
                const up = () => {
                    panel.classList.remove('gz-float--dragging');
                    window.removeEventListener('mousemove', move);
                    window.removeEventListener('mouseup', up);
                    const r2 = panel.getBoundingClientRect();
                    try { localStorage.setItem(k('x'), String(r2.left)); localStorage.setItem(k('y'), String(r2.top)); } catch (_) {}
                };
                window.addEventListener('mousemove', move);
                window.addEventListener('mouseup', up);
            });
        }

        // zwijanie
        const collapseBtn = panel.querySelector('[data-float-collapse]');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                panel.classList.toggle('gz-float--collapsed');
                try { localStorage.setItem(k('collapsed'), panel.classList.contains('gz-float--collapsed') ? '1' : '0'); } catch (_) {}
            });
        }

        this._floatStorageKey = this._floatStorageKey || {};
        this._floatStorageKey[storageKey] = panel;
    }

    /** Ustawia pozycję panelu z ograniczeniem do widocznego obszaru okna. */
    placeFloating(panel, x, y) {
        const w = panel.offsetWidth || 260;
        const h = panel.offsetHeight || 60;
        const margin = 6;
        const maxX = Math.max(margin, window.innerWidth - w - margin);
        const maxY = Math.max(margin, window.innerHeight - h - margin);
        const cx = Math.max(margin, Math.min(maxX, x));
        const cy = Math.max(margin, Math.min(maxY, y));
        panel.style.left = cx + 'px';
        panel.style.top = cy + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }

    /** Pokaż / ukryj panel warstw + zapamiętaj. */
    toggleLayersPanel() {
        if (!this.hasLayersTarget) { return; }
        const panel = this.layersTarget;
        panel.hidden = !panel.hidden;
        try { localStorage.setItem('gz.panel.gz_layers.hidden', panel.hidden ? '1' : '0'); } catch (_) {}
        if (!panel.hidden) {
            // upewnij się, że jest w widocznym obszarze (po resize ekranu mógł wyjechać)
            const r = panel.getBoundingClientRect();
            this.placeFloating(panel, r.left, r.top);
            this.renderLayers();
        }
        this.reflectLayersBtn();
    }

    reflectLayersBtn() {
        if (!this.hasLayersBtnTarget) { return; }
        const open = this.hasLayersTarget && !this.layersTarget.hidden;
        this.layersBtnTarget.classList.toggle('active', open);
    }

    // ─── Panel warstw (lista elementów bieżącej strony) ──────────

    /** Buduje listę warstw bieżącej strony. Na górze listy = na wierzchu (intuicyjne dla DTP). */
    renderLayers() {
        if (!this.hasLayersTarget) { return; }
        const root = this.layersTarget;
        const list = root.querySelector('[data-layers-list]');
        const empty = root.querySelector('[data-layers-empty]');
        const cnt = root.querySelector('[data-layers-count]');
        if (!list || !empty || !cnt) { return; }
        list.innerHTML = '';
        const els = this.page().elements || [];
        cnt.textContent = els.length ? (els.length + ' szt.') : '';
        empty.style.display = els.length ? 'none' : '';
        // Iteracja od końca (najwyższa warstwa na górze listy).
        for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            const row = document.createElement('div');
            row.className = 'gz-layer' + (el.hidden ? ' gz-layer--hidden' : '');
            row.dataset.id = el.id;
            row.draggable = true;
            row.title = 'Klik = zaznacz · Dwuklik na nazwie = edytuj etykietę · Przeciągnij = zmień kolejność warstw';
            const icon = this.layerIcon(el);
            const label = this.escapeForAttr(this.layerLabel(el));
            const hasCustom = (typeof el.label === 'string' && el.label.trim() !== '');
            const eyeIcon = el.hidden ? 'ti-eye-off' : 'ti-eye';
            const eyeTitle = el.hidden ? 'Pokaż warstwę' : 'Ukryj warstwę';
            row.innerHTML = `<span class="gz-layer__grip" aria-hidden="true">⠿</span>`
                + `<span class="gz-layer__eye" role="button" tabindex="-1" data-act="vis" aria-label="${eyeTitle}" title="${eyeTitle}"><i class="ti ${eyeIcon}"></i></span>`
                + `<span class="gz-layer__icon"><i class="ti ${icon}"></i></span>`
                + `<span class="gz-layer__label${hasCustom ? ' gz-layer__label--custom' : ''}" tabindex="-1" title="Dwuklik, by zmienić nazwę">${label}</span>`
                + `<span class="gz-layer__hint">${i + 1}</span>`;
            // Dwuklik na etykiecie → edycja inline
            const labelEl = row.querySelector('.gz-layer__label');
            labelEl.addEventListener('dblclick', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                this.startLayerRename(row, el);
            });
            // Klik w „oko" — bez DnD i bez goTo; toggle widoczności.
            const eye = row.querySelector('[data-act="vis"]');
            if (eye) {
                eye.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
                eye.addEventListener('dragstart', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
                eye.addEventListener('click', (ev) => { ev.stopPropagation(); this.toggleLayerVisibility(el.id); });
            }
            this.wireLayerDnd(row);
            list.appendChild(row);
        }
        this.renderLayersSelection();
    }

    /** Aktualizuje wyróżnienie aktywnej warstwy (bez przerysowywania całej listy). */
    renderLayersSelection() {
        if (!this.hasLayersTarget) { return; }
        const sel = new Set(this.selectedIds || []);
        this.layersTarget.querySelectorAll('.gz-layer').forEach((row) => {
            row.classList.toggle('is-active', sel.has(row.dataset.id));
        });
        // Doczytaj zaznaczoną pozycję do widoku, jeśli jest poza.
        const first = this.layersTarget.querySelector('.gz-layer.is-active');
        if (first && first.scrollIntoView) { first.scrollIntoView({ block: 'nearest' }); }
    }

    onLayerClick(e) {
        const row = e.target.closest('.gz-layer');
        if (!row) { return; }
        const id = row.dataset.id;
        if (!id) { return; }
        // Shift = zaznaczanie wielokrotne (analogicznie do canvas)
        this.select(id, !!(e.shiftKey || e.metaKey || e.ctrlKey));
    }

    /** Toggle widoczności warstwy (`el.hidden`). Ukryte: nie renderują się, nie oblewają tekstem, nie wchodzą do PDF. */
    toggleLayerVisibility(id) {
        const el = this.elById(id);
        if (!el) { return; }
        if (el.hidden) { delete el.hidden; } else { el.hidden = true; }
        // Jeśli ukrywamy zaznaczony element — odznacz, żeby transformer nie wisiał w pustce.
        if (el.hidden && this.selectedIds.includes(id)) {
            this.select(null);
        }
        this.markDirty();
        this.renderPage();      // rebuilduje canvas (pomija ukryte)
        this.renderLayers();    // odśwież listę warstw (ikony oka)
    }

    /** Inline-edycja etykiety warstwy: span → input → Enter zapisz / Esc anuluj / blur zapisz. */
    startLayerRename(row, el) {
        const labelEl = row.querySelector('.gz-layer__label');
        if (!labelEl || labelEl.dataset.editing === '1') { return; }
        labelEl.dataset.editing = '1';
        const current = (typeof el.label === 'string' && el.label.trim()) ? el.label : this.layerLabel(el);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'gz-layer__rename';
        input.value = current;
        input.maxLength = 60;
        input.placeholder = 'Nazwa warstwy (puste = auto)';
        // ZABEZPIECZENIA: input nie startuje DnD ani goTo, nie wpada w global keydown.
        const stop = (ev) => ev.stopPropagation();
        input.addEventListener('mousedown', stop);
        input.addEventListener('click', stop);
        input.addEventListener('dragstart', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
        input.addEventListener('keydown', (ev) => {
            ev.stopPropagation(); // by Delete/Backspace nie usuwało zaznaczonego elementu na canvasie
            if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
            else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
        });
        input.addEventListener('blur', () => commit(true));

        // Wyłącz drag całego wiersza w trakcie edycji
        const wasDraggable = row.draggable;
        row.draggable = false;

        let done = false;
        const commit = (save) => {
            if (done) { return; }
            done = true;
            row.draggable = wasDraggable;
            if (save) {
                const next = (input.value || '').trim();
                const target = this.elById(el.id);
                if (target) {
                    const old = target.label || '';
                    if (next === '') { delete target.label; }
                    else if (next !== old) { target.label = next; }
                    else { /* bez zmian */ }
                    if (old !== (target.label || '')) { this.markDirty(); }
                }
            }
            // pełny render listy (uwzględni nową etykietę / klasę custom / kolejność)
            this.renderLayers();
        };

        labelEl.replaceWith(input);
        input.focus();
        input.select();
    }

    /** Podpina handlery drag&drop do wiersza listy warstw (zmiana z-order przez przeciąganie). */
    wireLayerDnd(row) {
        row.addEventListener('dragstart', (e) => {
            this._layerDragSrc = row.dataset.id;
            row.classList.add('gz-layer--dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', 'gz-layer-' + row.dataset.id); } catch (_) {}
            }
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('gz-layer--dragging');
            if (!this.hasLayersTarget) { return; }
            this.layersTarget.querySelectorAll('.gz-layer--drop-before,.gz-layer--drop-after')
                .forEach((n) => n.classList.remove('gz-layer--drop-before', 'gz-layer--drop-after'));
            this._layerDragSrc = null;
        });
        row.addEventListener('dragover', (e) => {
            if (!this._layerDragSrc || this._layerDragSrc === row.dataset.id) { return; }
            e.preventDefault();
            if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
            const r = row.getBoundingClientRect();
            const before = (e.clientY - r.top) < r.height / 2;
            row.classList.toggle('gz-layer--drop-before', before);
            row.classList.toggle('gz-layer--drop-after', !before);
        });
        row.addEventListener('dragleave', () => {
            row.classList.remove('gz-layer--drop-before', 'gz-layer--drop-after');
        });
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            const srcId = this._layerDragSrc;
            const tgtId = row.dataset.id;
            this._layerDragSrc = null;
            if (!srcId || srcId === tgtId) { return; }
            const r = row.getBoundingClientRect();
            const before = (e.clientY - r.top) < r.height / 2;
            this.reorderLayerByDrop(srcId, tgtId, before);
        });
    }

    /**
     * Zmienia z-order: przenosi element o id=srcId względem tgtId.
     * Lista jest renderowana od końca tablicy (góra listy = wierzch canvasu),
     * więc:  drop „before" (wyżej w liście) = wyższa pozycja w tablicy (większy index po wycięciu źródła).
     */
    reorderLayerByDrop(srcId, tgtId, before) {
        const els = this.page().elements;
        const srcIdx = els.findIndex((e) => e.id === srcId);
        if (srcIdx < 0) { return; }
        const [picked] = els.splice(srcIdx, 1);
        const newTgtIdx = els.findIndex((e) => e.id === tgtId);
        if (newTgtIdx < 0) {
            // target zniknął (nie powinno się zdarzyć) — przywróć
            els.splice(srcIdx, 0, picked);
            return;
        }
        const insertAt = before ? (newTgtIdx + 1) : newTgtIdx;
        els.splice(insertAt, 0, picked);
        this.markDirty();
        this.renderPage();
        if (this.hasStatusTarget) { this.statusTarget.textContent = 'Zmieniono kolejność warstw.'; }
    }

    /** Ikona Tabler dla typu elementu (z drobnymi wariantami: lista, tło włączone). */
    layerIcon(el) {
        switch (el.type) {
            case 'text':
                if (el.list === 'bullet') { return 'ti-list'; }
                if (el.list === 'number') { return 'ti-list-numbers'; }
                if (el.bgOn) { return 'ti-square-letter-t'; }
                return 'ti-letter-t';
            case 'image': return 'ti-photo';
            case 'icon':  return 'ti-shape';
            case 'rect':  return (el.gradientType === 'linear' || el.gradientType === 'radial')
                ? 'ti-color-swatch' : 'ti-rectangle';
            case 'line':  return 'ti-minus';
            default:      return 'ti-box';
        }
    }

    /** Etykieta dla pozycji listy warstw — własna (el.label) ma pierwszeństwo, inaczej auto wg typu. */
    layerLabel(el) {
        const trim = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? (s.slice(0, n - 1) + '…') : s; };
        if (typeof el.label === 'string' && el.label.trim()) { return trim(el.label, 40); }
        if (el.type === 'text') {
            const t = trim(el.text, 38);
            return t || '(pusty tekst)';
        }
        if (el.type === 'image') {
            return el.src && el.src.startsWith('data:') ? 'Grafika (wbudowana)' : 'Grafika';
        }
        if (el.type === 'icon') {
            return el.iconName ? ('Ikona: ' + el.iconName) : 'Ikona';
        }
        if (el.type === 'rect') {
            if (el.gradientType === 'linear' || el.gradientType === 'radial') {
                return 'Ramka (gradient)';
            }
            return 'Ramka';
        }
        if (el.type === 'line') { return 'Linia'; }
        return el.type || 'Element';
    }

    /** Tekst bezpieczny do wstawienia w innerHTML. */
    escapeForAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    renderThumbs() {
        const wrap = this.thumbsTarget;
        wrap.innerHTML = '';
        this.doc.pages.forEach((p, i) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.draggable = true;
            item.dataset.idx = String(i);
            item.title = 'Przeciągnij, aby zmienić kolejność stron';
            item.className = 'gz-thumb' + (i === this.current ? ' gz-thumb--active' : '');
            item.innerHTML = `<span class="gz-thumb__sheet"></span><span class="gz-thumb__num">${i + 1}</span>`
                + `<span class="gz-thumb__dup" role="button" tabindex="-1" aria-label="Duplikuj stronę ${i + 1}" title="Duplikuj stronę ${i + 1}" draggable="false">⎘</span>`
                + (this.doc.pages.length > 1
                    ? `<span class="gz-thumb__del" role="button" tabindex="-1" aria-label="Usuń stronę ${i + 1}" title="Usuń stronę ${i + 1}" draggable="false">×</span>`
                    : '');
            item.addEventListener('click', () => this.goTo(i));
            // pomocnik: przycisk-overlay nie wywołuje goTo ani DnD
            const wireOverlayBtn = (sel, action) => {
                const b = item.querySelector(sel);
                if (!b) { return; }
                b.addEventListener('mousedown', (e) => { e.stopPropagation(); });
                b.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
                b.addEventListener('click', (e) => { e.stopPropagation(); action(); });
            };
            wireOverlayBtn('.gz-thumb__dup', () => this.duplicatePageAt(i));
            wireOverlayBtn('.gz-thumb__del', () => this.deletePage(i));
            // ── Drag&drop: zmiana kolejności stron ──
            item.addEventListener('dragstart', (e) => {
                this._dragFrom = i;
                item.classList.add('gz-thumb--dragging');
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    try { e.dataTransfer.setData('text/plain', 'gz-page-' + i); } catch (_) { /* Safari */ }
                }
            });
            item.addEventListener('dragend', () => {
                item.classList.remove('gz-thumb--dragging');
                wrap.querySelectorAll('.gz-thumb--drop-before,.gz-thumb--drop-after')
                    .forEach((n) => n.classList.remove('gz-thumb--drop-before', 'gz-thumb--drop-after'));
                this._dragFrom = null;
            });
            item.addEventListener('dragover', (e) => {
                if (this._dragFrom == null) { return; }
                e.preventDefault();
                if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
                const r = item.getBoundingClientRect();
                const after = (e.clientX - r.left) > r.width / 2;
                item.classList.toggle('gz-thumb--drop-before', !after);
                item.classList.toggle('gz-thumb--drop-after', after);
            });
            item.addEventListener('dragleave', () => {
                item.classList.remove('gz-thumb--drop-before', 'gz-thumb--drop-after');
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                const from = this._dragFrom;
                this._dragFrom = null;
                if (from == null || from === i) { return; }
                const r = item.getBoundingClientRect();
                const after = (e.clientX - r.left) > r.width / 2;
                let to = i + (after ? 1 : 0);
                if (to > from) { to -= 1; } // korekta po wycięciu źródła
                this.movePage(from, to);
            });
            wrap.appendChild(item);
        });
    }

    /** Przesuwa stronę z pozycji `from` na pozycję `to` (po cięciu źródła). */
    movePage(from, to) {
        const n = this.doc.pages.length;
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) { return; }
        const [pg] = this.doc.pages.splice(from, 1);
        this.doc.pages.splice(to, 0, pg);
        // utrzymujemy w „bieżącej" przesuniętą stronę
        if (this.current === from) { this.current = to; }
        else if (from < this.current && to >= this.current) { this.current -= 1; }
        else if (from > this.current && to <= this.current) { this.current += 1; }
        this.markDirty();
        this.select(null);
        this.renderThumbs();
        this.renderPage();
        if (this.hasStatusTarget) { this.statusTarget.textContent = `Przeniesiono stronę ${from + 1} → ${to + 1}.`; }
    }

    goTo(i) {
        if (i < 0 || i >= this.doc.pages.length) return;
        this.current = i;
        this.select(null);
        this.renderThumbs();
        this.renderPage();
    }

    prevPage() { this.goTo(this.current - 1); }
    nextPage() { this.goTo(this.current + 1); }

    addPage() {
        this.doc.pages.push({ background: '#ffffff', elements: [] });
        this.markDirty();
        this.current = this.doc.pages.length - 1;
        this.renderThumbs();
        this.renderPage();
    }

    removePage() { this.deletePage(this.current); }

    duplicatePage() { this.duplicatePageAt(this.current); }

    /** Duplikuje stronę o indeksie `idx`: wstawia kopię tuż za nią (z nowymi id elementów) i przechodzi na nią. */
    duplicatePageAt(idx) {
        const n = this.doc.pages.length;
        if (idx < 0 || idx >= n) { return; }
        const src = this.doc.pages[idx];
        const copy = JSON.parse(JSON.stringify(src));
        for (const el of (copy.elements || [])) {
            if (el && typeof el === 'object') { el.id = uid(); }
        }
        const at = idx + 1;
        this.doc.pages.splice(at, 0, copy);
        this.current = at;
        this.markDirty();
        this.select(null);
        this.renderThumbs();
        this.renderPage();
        if (this.hasStatusTarget) { this.statusTarget.textContent = `Zduplikowano stronę ${idx + 1} → ${at + 1}.`; }
    }

    /** Usuwa stronę o indeksie `idx` (z potwierdzeniem). Aktualizuje `current`. */
    deletePage(idx) {
        const n = this.doc.pages.length;
        if (idx < 0 || idx >= n) { return; }
        if (n <= 1) {
            if (this.hasStatusTarget) { this.statusTarget.textContent = 'Nie można usunąć ostatniej strony.'; }
            return;
        }
        if (!confirm(`Usunąć stronę ${idx + 1} wraz z zawartością?\nTej operacji nie można cofnąć w tej sesji.`)) { return; }
        this.doc.pages.splice(idx, 1);
        // utrzymaj sensowny `current`
        if (this.current === idx) { this.current = Math.min(idx, this.doc.pages.length - 1); }
        else if (this.current > idx) { this.current -= 1; }
        this.markDirty();
        this.select(null);
        this.renderThumbs();
        this.renderPage();
        if (this.hasStatusTarget) { this.statusTarget.textContent = `Usunięto stronę ${idx + 1}.`; }
    }

    updatePageInfo() {
        if (this.hasPageInfoTarget) {
            this.pageInfoTarget.textContent = `Strona ${this.current + 1} / ${this.doc.pages.length}`;
        }
    }

    // ─── Zoom ───────────────────────────────────────────────

    fitZoom() {
        const avail = (this.containerTarget?.clientWidth || 800) - 24;
        const z = avail / this.pageW;
        return clamp(z, 0.4, 1.6);
    }

    applyZoom() {
        this.stage.scale({ x: this.zoom, y: this.zoom });
        this.stage.size({ width: this.pageW * this.zoom, height: this.pageH * this.zoom });
        this.stage.draw();
        this.updateZoomLabel();
    }

    zoomIn() { this.zoom = clamp(this.zoom + 0.1, 0.3, 2.5); this.applyZoom(); }
    zoomOut() { this.zoom = clamp(this.zoom - 0.1, 0.3, 2.5); this.applyZoom(); }
    zoomFit() { this.zoom = this.fitZoom(); this.applyZoom(); }
    zoomReset() { this.zoom = 1; this.applyZoom(); }
    updateZoomLabel() {
        if (this.hasZoomLabelTarget) this.zoomLabelTarget.textContent = Math.round(this.zoom * 100) + '%';
    }

    /**
     * Zoom skupiony na PUNKCIE pod kursorem — zachowuje pozycję pt pod kursorem przy zmianie zoomu.
     * Po zmianie zoomu przesuwa scroll canvas-wrap tak, by piksel ekranowy (px,py) pozostał nad tym samym pt.
     */
    zoomToPoint(newZoom, clientX, clientY) {
        const oldZoom = this.zoom;
        newZoom = clamp(newZoom, 0.3, 2.5);
        if (Math.abs(newZoom - oldZoom) < 0.001) { return; }
        const stageEl = this.stage.container();
        const rect = stageEl.getBoundingClientRect();
        // Punkt strony (pt) pod kursorem PRZED zmianą zoomu.
        const ptX = (clientX - rect.left) / oldZoom;
        const ptY = (clientY - rect.top) / oldZoom;
        this.zoom = newZoom;
        this.applyZoom();
        // Po applyZoom stage zmienia rozmiar; ponowny pomiar i korekta scrollu canvas-wrap.
        const wrap = stageEl.closest('.gz-canvas-wrap');
        if (!wrap) { return; }
        const rect2 = stageEl.getBoundingClientRect();
        const newCursorX = rect2.left + ptX * newZoom;
        const newCursorY = rect2.top + ptY * newZoom;
        wrap.scrollLeft += (newCursorX - clientX);
        wrap.scrollTop  += (newCursorY - clientY);
    }

    // ─── Pasek narzędzi (zwijany / z opisami) ───────────────

    toggleToolbar() {
        this._toolbarExpanded = !this._toolbarExpanded;
        this.applyToolbarState();
        try { localStorage.setItem('gzToolbarExpanded', this._toolbarExpanded ? '1' : '0'); } catch (e) { /* brak localStorage */ }
    }

    applyToolbarState() {
        if (this.hasToolbarTarget) this.toolbarTarget.classList.toggle('gz-toolbar--expanded', !!this._toolbarExpanded);
    }

    // ─── Siatka i przyciąganie ──────────────────────────────

    drawGrid() {
        if (!this.snap) return;
        const K = this.Konva;
        const g = this.gridSize;
        for (let x = g; x < this.pageW; x += g) {
            this.layer.add(new K.Line({ points: [x, 0, x, this.pageH], stroke: '#d7deea', strokeWidth: 0.5, listening: false }));
        }
        for (let y = g; y < this.pageH; y += g) {
            this.layer.add(new K.Line({ points: [0, y, this.pageW, y], stroke: '#d7deea', strokeWidth: 0.5, listening: false }));
        }
    }

    snapPos(pos, el) {
        let x = pos.x, y = pos.y;
        // Group-drag: snap stosujemy TYLKO dla lidera (klikniętego elementu).
        // Gdy Konva równolegle wywoła dragBoundFunc dla pozostałych przeciąganych nodów,
        // dostają RAW pos — przesuną się o tę samą delta co lider, zachowując względne odstępy.
        // (Bez tego każdy snapował by się do swojej najbliższej kratki/linii → drift.)
        if (this._dragLeader && el.id !== this._dragLeader) { return { x, y }; }
        // 1) Snap do SIATKI — tylko gdy `this.snap` jest włączone (top-left do gridu).
        if (this.snap) {
            const g = this.gridSize * this.zoom;
            x = Math.round(pos.x / g) * g;
            y = Math.round(pos.y / g) * g;
        }
        // 2) Snap do LINII POMOCNICZYCH — sprawdzamy WSZYSTKIE krawędzie elementu:
        //    górę / dół / środek-Y dla linii poziomych; lewą / prawą / środek-X dla pionowych.
        //    Dzięki temu element przyciąga się też do PRAWEGO i DOLNEGO marginesu.
        const guides = this.doc && this.doc.guides;
        if (guides && el) {
            const tol = 8 * this.zoom;
            const w = (el.width || 0) * this.zoom;
            const h = (el.height || 0) * this.zoom;
            // Linie poziome → szukamy NAJBLIŻSZEGO dopasowania jednej z 3 krawędzi Y.
            let bestY = null, bestYDist = tol;
            for (const gy of (guides.h || [])) {
                const target = gy * this.zoom;
                // Górna krawędź
                const dT = Math.abs(pos.y - target);
                if (dT < bestYDist) { bestY = target; bestYDist = dT; }
                if (h > 0) {
                    // Dolna krawędź: pos.y + h = target → pos.y = target - h
                    const dB = Math.abs((pos.y + h) - target);
                    if (dB < bestYDist) { bestY = target - h; bestYDist = dB; }
                    // Środek (pion)
                    const dC = Math.abs((pos.y + h / 2) - target);
                    if (dC < bestYDist) { bestY = target - h / 2; bestYDist = dC; }
                }
            }
            if (bestY !== null) { y = bestY; }
            // Linie pionowe → analogicznie dla 3 krawędzi X.
            let bestX = null, bestXDist = tol;
            for (const gx of (guides.v || [])) {
                const target = gx * this.zoom;
                const dL = Math.abs(pos.x - target);
                if (dL < bestXDist) { bestX = target; bestXDist = dL; }
                if (w > 0) {
                    const dR = Math.abs((pos.x + w) - target);
                    if (dR < bestXDist) { bestX = target - w; bestXDist = dR; }
                    const dC = Math.abs((pos.x + w / 2) - target);
                    if (dC < bestXDist) { bestX = target - w / 2; bestXDist = dC; }
                }
            }
            if (bestX !== null) { x = bestX; }
        }
        return { x, y };
    }

    /**
     * Snap bounding-box podczas resize: 1) siatka (jak dotąd), 2) linie pomocnicze do KRAWĘDZI która się porusza
     * (top/bottom dla linii poziomych, left/right dla pionowych). Zachowuje przeciwległy bok w miejscu.
     */
    snapBoundBox(oldBox, newBox) {
        if (Math.abs(newBox.rotation) > 0.01) { return newBox; }

        // 1) Wykryj KTÓRA krawędź się porusza — PRZED snapem do siatki.
        //    Inaczej grid mógłby zaokrąglić newBox z powrotem do oldBox i detekcja zwróciłaby „żadna".
        const leftMoved   = Math.abs(newBox.x - oldBox.x) > 0.01;
        const topMoved    = Math.abs(newBox.y - oldBox.y) > 0.01;
        const rightMoved  = Math.abs((newBox.x + newBox.width)  - (oldBox.x + oldBox.width))  > 0.01;
        const bottomMoved = Math.abs((newBox.y + newBox.height) - (oldBox.y + oldBox.height)) > 0.01;

        // 2) Snap do LINII POMOCNICZYCH — PIERWSZEŃSTWO przed siatką, na nieprzetworzonym newBox
        //    (żeby porównanie z guide nie było obarczone błędem kwantyzacji do siatki).
        const guides = this.doc && this.doc.guides;
        const tol = 8 * this.zoom;
        let ySnappedByGuide = false, xSnappedByGuide = false;

        if (guides && (topMoved || bottomMoved)) {
            let bestDist = tol, snap = null;
            for (const gy of (guides.h || [])) {
                const target = gy * this.zoom;
                if (topMoved) {
                    const d = Math.abs(newBox.y - target);
                    if (d < bestDist) { bestDist = d; snap = { edge: 'top', target }; }
                }
                if (bottomMoved) {
                    const d = Math.abs((newBox.y + newBox.height) - target);
                    if (d < bestDist) { bestDist = d; snap = { edge: 'bottom', target }; }
                }
            }
            if (snap) {
                if (snap.edge === 'top') {
                    // Top → guide; zachowaj BOTTOM (newBox.y + newBox.height = const).
                    const bottom = newBox.y + newBox.height;
                    const h = bottom - snap.target;
                    if (h >= 8) { newBox = { ...newBox, y: snap.target, height: h }; ySnappedByGuide = true; }
                } else {
                    // Bottom → guide; zachowaj TOP (newBox.y = const).
                    const h = snap.target - newBox.y;
                    if (h >= 8) { newBox = { ...newBox, height: h }; ySnappedByGuide = true; }
                }
            }
        }
        if (guides && (leftMoved || rightMoved)) {
            let bestDist = tol, snap = null;
            for (const gx of (guides.v || [])) {
                const target = gx * this.zoom;
                if (leftMoved) {
                    const d = Math.abs(newBox.x - target);
                    if (d < bestDist) { bestDist = d; snap = { edge: 'left', target }; }
                }
                if (rightMoved) {
                    const d = Math.abs((newBox.x + newBox.width) - target);
                    if (d < bestDist) { bestDist = d; snap = { edge: 'right', target }; }
                }
            }
            if (snap) {
                if (snap.edge === 'left') {
                    const right = newBox.x + newBox.width;
                    const w = right - snap.target;
                    if (w >= 8) { newBox = { ...newBox, x: snap.target, width: w }; xSnappedByGuide = true; }
                } else {
                    const w = snap.target - newBox.x;
                    if (w >= 8) { newBox = { ...newBox, width: w }; xSnappedByGuide = true; }
                }
            }
        }

        // 3) Snap do SIATKI — tylko na osie, których nie złapała linia pomocnicza.
        if (this.snap) {
            const g = this.gridSize * this.zoom;
            if (!xSnappedByGuide) {
                newBox = {
                    ...newBox,
                    x: Math.round(newBox.x / g) * g,
                    width: Math.max(g, Math.round(newBox.width / g) * g),
                };
            }
            if (!ySnappedByGuide) {
                newBox = {
                    ...newBox,
                    y: Math.round(newBox.y / g) * g,
                    height: Math.max(g, Math.round(newBox.height / g) * g),
                };
            }
        }
        return newBox;
    }

    // ─── Linie pomocnicze (guides) — QuarkXPress-style przeciągane z linijek ──────

    /** Renderuje aktualne linie pomocnicze na warstwie guideLayer (między layer a ui).
     *  Linie SĄ DRAGOWALNE — chwytasz i przesuwasz; constrain do jednej osi przez dragBoundFunc. */
    renderGuides() {
        if (!this.guideLayer) { return; }
        this.guideLayer.destroyChildren();
        const K = this.Konva;
        const g = (this.doc && this.doc.guides) || { h: [], v: [] };
        const z = this.zoom;

        const mkLine = (axis, value) => {
            const points = (axis === 'h')
                ? [-2000, value, this.pageW + 2000, value]
                : [value, -2000, value, this.pageH + 2000];
            const line = new K.Line({
                points, stroke: '#00b8d4', strokeWidth: 0.8 / z, dash: [4 / z, 3 / z],
                listening: true, hitStrokeWidth: 12 / z,
                draggable: true,
                // Constrain do JEDNEJ osi (horizontal-guide → tylko Y; vertical-guide → tylko X).
                dragBoundFunc: (pos) => (axis === 'h') ? { x: 0, y: pos.y } : { x: pos.x, y: 0 },
            });
            // Wizualne hint-y: hover staje się czerwony („zaraz przesunę / mogę usunąć").
            line.on('mouseenter', () => {
                this.stage.container().style.cursor = (axis === 'h') ? 'ns-resize' : 'ew-resize';
                line.stroke('#ff3366'); line.strokeWidth(1.0 / this.zoom); this.guideLayer.batchDraw();
            });
            line.on('mouseleave', () => {
                this.stage.container().style.cursor = '';
                line.stroke('#00b8d4'); line.strokeWidth(0.8 / this.zoom); this.guideLayer.batchDraw();
            });
            line.on('dragmove', () => {
                // Live update statusu — bieżąca pozycja w pt
                const delta = (axis === 'h') ? line.y() : line.x();
                const cur = Math.round(value + delta);
                if (this.hasStatusTarget) {
                    this.statusTarget.textContent = (axis === 'h' ? 'Linia pozioma Y=' : 'Linia pionowa X=') + cur + ' pt';
                }
            });
            line.on('dragend', () => {
                const delta = (axis === 'h') ? line.y() : line.x();
                const newVal = Math.round(value + delta);
                const arr = this.doc.guides[axis];
                const oldIdx = arr.indexOf(value);
                if (oldIdx < 0) { this.renderGuides(); return; }
                // Drop poza stronę → usuwa (drag-to-delete jak w QuarkXPress)
                const outOfBounds = (axis === 'h')
                    ? (newVal <= 0 || newVal >= this.pageH)
                    : (newVal <= 0 || newVal >= this.pageW);
                if (outOfBounds) {
                    arr.splice(oldIdx, 1);
                    if (this.hasStatusTarget) { this.statusTarget.textContent = 'Linia usunięta.'; }
                } else {
                    arr[oldIdx] = newVal;
                    this.doc.guides[axis] = Array.from(new Set(arr)).sort((a, b) => a - b);
                    if (this.hasStatusTarget) { this.statusTarget.textContent = (axis === 'h' ? 'Linia Y=' : 'Linia X=') + newVal + ' pt'; }
                }
                this.markDirty();
                this.renderGuides();
            });
            line.on('contextmenu', (e) => {
                e.evt && e.evt.preventDefault();
                this.removeGuide(axis, value);
            });
            return line;
        };

        for (const y of (g.h || [])) { this.guideLayer.add(mkLine('h', y)); }
        for (const x of (g.v || [])) { this.guideLayer.add(mkLine('v', x)); }
        this.guideLayer.batchDraw();
    }

    /** Akcja Stimulus: mousedown na linijce → drag → drop = nowa linia pomocnicza.
     *  param `axis` = 'h' (linijka GÓRNA, kreśli linię poziomą) lub 'v' (LEWA, pionową). */
    startGuideDrag(e) {
        const axis = (e.params && e.params.axis) || 'h';
        e.preventDefault();
        const K = this.Konva;
        const preview = new K.Line({
            points: [], stroke: '#00b8d4', strokeWidth: 0.6 / this.zoom, dash: [4 / this.zoom, 3 / this.zoom], listening: false,
        });
        this.guideLayer.add(preview);
        const stageEl = this.stage.container();
        const ptFromEvent = (ev) => {
            const r = stageEl.getBoundingClientRect();
            return {
                x: (ev.clientX - r.left) / this.zoom,
                y: (ev.clientY - r.top) / this.zoom,
                insideStage: ev.clientX >= r.left && ev.clientX <= r.right
                          && ev.clientY >= r.top && ev.clientY <= r.bottom,
            };
        };
        const onMove = (ev) => {
            const p = ptFromEvent(ev);
            if (axis === 'h') { preview.points([-2000, p.y, this.pageW + 2000, p.y]); }
            else { preview.points([p.x, -2000, p.x, this.pageH + 2000]); }
            this.guideLayer.batchDraw();
        };
        const onUp = (ev) => {
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('mouseup', onUp, true);
            const p = ptFromEvent(ev);
            try { preview.destroy(); this.guideLayer.batchDraw(); } catch (_) { /* OK */ }
            if (!p.insideStage) { return; } // drop poza stronę → anuluj
            this.doc.guides = this.doc.guides || { h: [], v: [] };
            if (axis === 'h') {
                const yPt = Math.round(p.y);
                if (yPt > 0 && yPt < this.pageH) { this.doc.guides.h.push(yPt); }
            } else {
                const xPt = Math.round(p.x);
                if (xPt > 0 && xPt < this.pageW) { this.doc.guides.v.push(xPt); }
            }
            this.doc.guides.h = Array.from(new Set(this.doc.guides.h)).sort((a, b) => a - b);
            this.doc.guides.v = Array.from(new Set(this.doc.guides.v)).sort((a, b) => a - b);
            this.markDirty();
            this.renderGuides();
        };
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
    }

    /** Usuwa pojedynczą linię pomocniczą (PPM na linii). */
    removeGuide(axis, value) {
        if (!this.doc.guides) { return; }
        const arr = this.doc.guides[axis];
        if (!Array.isArray(arr)) { return; }
        const idx = arr.indexOf(value);
        if (idx >= 0) {
            arr.splice(idx, 1);
            this.markDirty();
            this.renderGuides();
        }
    }

    /** Akcja Stimulus: czyści wszystkie linie pomocnicze (przycisk lub PPM na rogu linijek). */
    clearAllGuides(e) {
        if (e && typeof e.preventDefault === 'function') { e.preventDefault(); }
        const g = this.doc.guides;
        if (!g || (g.h.length === 0 && g.v.length === 0)) { return; }
        if (!confirm('Usunąć wszystkie linie pomocnicze?')) { return; }
        this.doc.guides = { h: [], v: [] };
        this.markDirty();
        this.renderGuides();
    }

    /** Akcja Stimulus: utwórz 4 linie marginesów strony — input akceptuje 1 wartość lub 4 (TRBL). */
    addMarginGuides() {
        const def = '36';
        const raw = prompt('Marginesy strony w pt (jedna wartość lub: GÓRA PRAWY DÓŁ LEWY oddzielone spacjami):', def);
        if (raw === null) { return; }
        const parts = raw.trim().split(/\s+/).map((p) => parseFloat(p));
        let top, right, bottom, left;
        if (parts.length === 1 && Number.isFinite(parts[0])) {
            top = right = bottom = left = parts[0];
        } else if (parts.length === 4 && parts.every(Number.isFinite)) {
            [top, right, bottom, left] = parts;
        } else {
            alert('Wpisz 1 wartość lub 4 wartości oddzielone spacjami.');
            return;
        }
        this.doc.guides = this.doc.guides || { h: [], v: [] };
        this.doc.guides.h.push(Math.round(top), Math.round(this.pageH - bottom));
        this.doc.guides.v.push(Math.round(left), Math.round(this.pageW - right));
        this.doc.guides.h = Array.from(new Set(this.doc.guides.h)).filter((y) => y > 0 && y < this.pageH).sort((a, b) => a - b);
        this.doc.guides.v = Array.from(new Set(this.doc.guides.v)).filter((x) => x > 0 && x < this.pageW).sort((a, b) => a - b);
        this.markDirty();
        this.renderGuides();
    }

    toggleGrid() {
        this.snap = !this.snap;
        if (this.hasGridBtnTarget) this.gridBtnTarget.classList.toggle('active', this.snap);
        this.renderPage();
    }

    setGridSize(e) {
        const v = parseInt(e.target.value, 10);
        if (v > 0 && v <= 500) {
            this.gridSize = v;
            this.doc.gridSize = v;       // zapis per-dokument — wartość pamiętana między sesjami
            this.markDirty();
            this.renderPage();
        }
    }

    /** Dialog zaawansowany: krok w pt LUB liczba podziałów strony (= pageW / N).
     *  „Liczba podziałów" ułatwia układy modułowe — np. 12 kolumn jak w CSS gridzie. */
    openGridConfig() {
        const mode = window.prompt(
            'Konfiguracja siatki — wybierz tryb:\n\n'
            + '  k = krok w punktach (np. 20)\n'
            + '  n = liczba podziałów strony (np. 12 → siatka 12-kolumnowa)\n\n'
            + 'Wpisz „k" albo „n":',
            'k'
        );
        if (!mode) return;
        const m = mode.trim().toLowerCase();
        if (m === 'k') {
            const v = window.prompt('Krok siatki (pt). Aktualnie: ' + this.gridSize, String(this.gridSize));
            if (!v) return;
            const n = parseFloat(v);
            if (n > 0 && n <= 500) {
                this.gridSize = Math.round(n);
                this.doc.gridSize = this.gridSize;
                if (this.hasGridSizeInputTarget) { this.gridSizeInputTarget.value = String(this.gridSize); }
                this.markDirty(); this.renderPage();
            } else {
                window.alert('Wpisz liczbę z zakresu 1–500.');
            }
        } else if (m === 'n') {
            const v = window.prompt('Liczba podziałów strony w poziomie (np. 12). Krok obliczy się jako szerokość strony / N.', '12');
            if (!v) return;
            const n = parseInt(v, 10);
            if (n >= 2 && n <= 100) {
                const step = Math.max(1, Math.round(this.pageW / n));
                this.gridSize = step;
                this.doc.gridSize = step;
                if (this.hasGridSizeInputTarget) { this.gridSizeInputTarget.value = String(step); }
                this.markDirty(); this.renderPage();
            } else {
                window.alert('Wpisz liczbę z zakresu 2–100.');
            }
        }
    }

    // ─── Numery stron ───────────────────────────────────────

    setPageNumbers(e) {
        const v = e.target.value;
        if (!this.doc.pageNumbers) this.doc.pageNumbers = {};
        if (v === 'off') {
            this.doc.pageNumbers.show = false;
        } else {
            this.doc.pageNumbers.show = true;
            this.doc.pageNumbers.position = v; // 'center' | 'outer'
        }
        this.markDirty();
        this.renderPage();
    }

    /** Rysuje numer strony na dole (środek lub do zewnątrz wg parzystości). Używane w edytorze i w eksporcie PDF. */
    drawPageNumber(layer, pageIndex) {
        const pn = this.doc.pageNumbers;
        if (!pn || !pn.show) return;
        const num = pageIndex + 1;
        const fontSize = 11;
        const marginX = 32, marginBottom = 22;
        const y = this.pageH - marginBottom - fontSize;

        let x, width, align;
        if (pn.position === 'outer') {
            // Nieparzyste = strony prawe (recto) → numer do prawej; parzyste = lewe → do lewej.
            align = num % 2 === 1 ? 'right' : 'left';
            x = marginX;
            width = this.pageW - marginX * 2;
        } else {
            align = 'center';
            x = 0;
            width = this.pageW;
        }

        layer.add(new this.Konva.Text({
            x, y, width, text: String(num),
            fontSize, fontFamily: 'Georgia', fill: '#555555', align, listening: false,
        }));
    }

    // ─── Zapis ──────────────────────────────────────────────

    markDirty() {
        this.dirty = true;
        this.statusTarget.textContent = 'Niezapisane zmiany…';
        this.pushHistory();
    }

    // ─── Historia (cofanie / ponawianie) ────────────────────

    snapshotNow() {
        const snap = JSON.stringify(this.doc);
        this.history = this.history.slice(0, this.histIdx + 1);
        if (this.history[this.histIdx] === snap) return;
        this.history.push(snap);
        if (this.history.length > 80) this.history.shift();
        this.histIdx = this.history.length - 1;
        this.updateHistButtons();
    }

    pushHistory() {
        if (this._restoring) return;
        clearTimeout(this._histTimer);
        this._histTimer = setTimeout(() => this.snapshotNow(), 350);
    }

    undo() {
        clearTimeout(this._histTimer);
        if (this.histIdx <= 0) return;
        this.histIdx--;
        this.restoreSnapshot();
    }

    redo() {
        clearTimeout(this._histTimer);
        if (this.histIdx >= this.history.length - 1) return;
        this.histIdx++;
        this.restoreSnapshot();
    }

    restoreSnapshot() {
        this._restoring = true;
        try {
            this.doc = JSON.parse(this.history[this.histIdx]);
            this.pageW = this.doc.pageW || this.pageW;
            this.pageH = this.doc.pageH || this.pageH;
            this.current = clamp(this.current, 0, this.doc.pages.length - 1);
            this.renderThumbs();
            this.renderPage();
            this.select(null);
            this.updateHistButtons();
            this.dirty = true;
            this.statusTarget.textContent = 'Cofnięto/ponowiono — niezapisane';
        } finally {
            this._restoring = false;
        }
    }

    updateHistButtons() {
        if (this.hasUndoBtnTarget) this.undoBtnTarget.disabled = this.histIdx <= 0;
        if (this.hasRedoBtnTarget) this.redoBtnTarget.disabled = this.histIdx >= this.history.length - 1;
    }

    async save() {
        this.statusTarget.textContent = 'Zapisywanie…';
        try {
            const res = await fetch(this.saveUrlValue, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': this.csrfValue,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify({ doc: this.doc, title: this.titleTarget.value }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd zapisu.');
            this.dirty = false;
            this.statusTarget.textContent = 'Zapisano ' + (data.savedAt || '');
        } catch (e) {
            this.statusTarget.textContent = 'Błąd zapisu: ' + e.message;
        }
    }

    // ─── Eksport PDF ────────────────────────────────────────

    /** Renderuje pojedynczą stronę do PNG (dataURL) w zadanej rozdzielczości. */
    pageToDataURL(pageIndex, pixelRatio) {
        const K = this.Konva;
        const tmpContainer = document.createElement('div');
        const stage = new K.Stage({ container: tmpContainer, width: this.pageW, height: this.pageH });
        const layer = new K.Layer();
        stage.add(layer);

        const page = this.doc.pages[pageIndex];
        layer.add(new K.Rect({ x: 0, y: 0, width: this.pageW, height: this.pageH, fill: page.background || '#ffffff' }));
        for (const el of page.elements) {
            if (el.hidden) { continue; }
            let node;
            try { node = this.buildNode(el, false); } catch (e) { node = null; }
            if (!node) { continue; }
            if (node._gzShadow && el.type === 'image') {
                layer.add(new K.Rect({
                    x: el.x, y: el.y, width: el.width, height: el.height,
                    rotation: el.rotation || 0,
                    cornerRadius: Math.max(0, el.cornerRadius || 0),
                    fill: 'rgba(0,0,0,0.01)',
                    shadowColor: 'rgba(0,0,0,0.35)', shadowBlur: 10, shadowOffsetX: 0, shadowOffsetY: 4,
                    listening: false,
                }));
            }
            layer.add(node);
        }
        this.drawPageNumber(layer, pageIndex);
        layer.draw();
        const url = stage.toDataURL({ pixelRatio, mimeType: 'image/png' });
        stage.destroy();
        return url;
    }

    // Domyślnie: PDF z PRAWDZIWYM tekstem wektorowym (ostry, zaznaczalny, lekki).
    async exportBooklet() { await this.exportVector(true); }
    async exportSequential() { await this.exportVector(false); }
    // Zapas: PDF rastrowy (cała strona jako obraz — gdyby ktoś użył nietypowej czcionki / chciał 1:1 z ekranem).
    async exportRasterBooklet() { await this.exportRaster(true); }
    async exportRasterSequential() { await this.exportRaster(false); }

    async exportRaster(booklet) {
        if (!window.PDFLib) { alert('Nie załadowano biblioteki pdf-lib.'); return; }
        this.statusTarget.textContent = 'Generowanie PDF (obraz)…';

        try {
            if (this.dirty) await this.save();
            await this.preloadAllImages();
            await this.preloadAllFonts();

            const pixelRatio = 3.3; // ~240 DPI (ostrzej niż dawne 180)
            const pagePng = this.doc.pages.map((_, i) => this.pageToDataURL(i, pixelRatio));

            const { PDFDocument } = window.PDFLib;
            const pdf = await PDFDocument.create();
            const embeds = [];
            for (const url of pagePng) embeds.push(await pdf.embedPng(url));

            if (!booklet) {
                for (const img of embeds) {
                    const p = pdf.addPage([this.pageW, this.pageH]);
                    p.drawImage(img, { x: 0, y: 0, width: this.pageW, height: this.pageH });
                }
            } else {
                const total = this.padToFour(embeds.length);
                const sheets = total / 4;
                const at = (n) => (n >= 1 && n <= embeds.length) ? embeds[n - 1] : null;
                const sheetW = this.pageW * 2, sheetH = this.pageH;
                const drawSide = (left, right) => {
                    const p = pdf.addPage([sheetW, sheetH]);
                    if (left) p.drawImage(left, { x: 0, y: 0, width: this.pageW, height: this.pageH });
                    if (right) p.drawImage(right, { x: this.pageW, y: 0, width: this.pageW, height: this.pageH });
                };
                for (let s = 0; s < sheets; s++) {
                    drawSide(at(total - 2 * s), at(1 + 2 * s));
                    drawSide(at(2 + 2 * s), at(total - 1 - 2 * s));
                }
            }

            const bytes = await pdf.save();
            const fname = (this.titleTarget.value || 'gazetka').replace(/[^\p{L}\p{N}_-]+/gu, '_')
                + (booklet ? '_do_druku_obraz' : '_po_kolei_obraz') + '.pdf';
            this.downloadBlob(new Blob([bytes], { type: 'application/pdf' }), fname);
            this.statusTarget.textContent = 'PDF (obraz) gotowy: ' + fname;
        } catch (e) {
            this.statusTarget.textContent = 'Błąd PDF: ' + e.message;
            console.error(e);
        }
    }

    padToFour(n) { return Math.ceil(n / 4) * 4; }

    // ─── Eksport PDF — prawdziwy tekst wektorowy (pdf-lib + osadzone kroje Google) ───

    async exportVector(booklet) {
        if (!window.PDFLib) { alert('Nie załadowano biblioteki pdf-lib.'); return; }
        if (!window.fontkit) { this.statusTarget.textContent = 'Brak fontkit — eksport obrazkowy.'; return this.exportRaster(booklet); }
        this.statusTarget.textContent = 'Generowanie PDF (tekst wektorowy)…';

        try {
            if (this.dirty) await this.save();
            await this.preloadAllImages();
            await this.preloadAllFonts();

            const { PDFDocument } = window.PDFLib;
            const pdf = await PDFDocument.create();
            try {
                await this.ensurePdfFonts(pdf);
            } catch (e) {
                console.error('Kroje PDF:', e);
                this.statusTarget.textContent = 'Nie wczytano krojów — eksport obrazkowy.';
                return this.exportRaster(booklet);
            }
            await this.pdfEmbedAllImages(pdf);

            const N = this.doc.pages.length;
            // Obrazy/ikony/ramki/linie z rotacją renderujemy wektorowo (pdfWithRotation).
            // Raster zostawiamy tylko dla TEKSTU z rotacją (skomplikowany layout w obróconym układzie).
            const needRaster = (idx) => (this.doc.pages[idx].elements || []).some((el) => el.rotation && el.type === 'text');
            const rasterCache = {};
            const ensureRaster = async (idx) => {
                if (rasterCache[idx] === undefined) rasterCache[idx] = await pdf.embedPng(this.pageToDataURL(idx, 3.3));
                return rasterCache[idx];
            };
            // Rysuje stronę idx na obszarze [ox, ox+pageW] danej strony PDF (wektorowo lub rastrowo dla obróconych).
            const drawRegion = async (pdfPage, idx, ox) => {
                if (idx == null || idx < 0 || idx >= N) return; // puste pole składki
                if (needRaster(idx)) {
                    const png = await ensureRaster(idx);
                    pdfPage.drawImage(png, { x: ox, y: 0, width: this.pageW, height: this.pageH });
                } else {
                    this.pdfDrawPage(pdfPage, this.doc.pages[idx], ox, 0, idx);
                }
            };

            if (!booklet) {
                for (let i = 0; i < N; i++) {
                    const p = pdf.addPage([this.pageW, this.pageH]);
                    await drawRegion(p, i, 0);
                }
            } else {
                const total = this.padToFour(N), sheets = total / 4;
                const at = (n) => (n >= 1 && n <= N) ? (n - 1) : null;
                for (let s = 0; s < sheets; s++) {
                    let p = pdf.addPage([this.pageW * 2, this.pageH]);
                    await drawRegion(p, at(total - 2 * s), 0);
                    await drawRegion(p, at(1 + 2 * s), this.pageW);
                    p = pdf.addPage([this.pageW * 2, this.pageH]);
                    await drawRegion(p, at(2 + 2 * s), 0);
                    await drawRegion(p, at(total - 1 - 2 * s), this.pageW);
                }
            }

            const bytes = await pdf.save({ useObjectStreams: false }); // lepsza zgodność czytników
            const fname = (this.titleTarget.value || 'gazetka').replace(/[^\p{L}\p{N}_-]+/gu, '_')
                + (booklet ? '_do_druku' : '_po_kolei') + '.pdf';
            this.downloadBlob(new Blob([bytes], { type: 'application/pdf' }), fname);
            this.statusTarget.textContent = 'PDF gotowy (tekst wektorowy): ' + fname;
        } catch (e) {
            this.statusTarget.textContent = 'Błąd PDF: ' + e.message;
            console.error(e);
        }
    }

    /** Pobiera i osadza (subset) potrzebne kroje TTF dla bieżącego dokumentu. Rzuca, gdy nie ma nawet kroju bazowego. */
    async ensurePdfFonts(pdf) {
        if (!this._fontManifest) {
            try { this._fontManifest = new Set(await (await fetch(PDF_FONTS_BASE + '/manifest.json')).json()); }
            catch (e) { this._fontManifest = new Set(); }
        }
        pdf.registerFontkit(window.fontkit);
        this._pdfFont = {};
        if (!this._fontBytes) this._fontBytes = {}; // cache bajtów TTF między eksportami

        const need = new Set(['gelasio-400', 'gelasio-700']);
        for (const box of this.doc.pages) for (const el of (box.elements || [])) {
            if (el.type !== 'text') continue;
            const fam = el.fontFamily || 'Georgia';
            for (const b of [0, 1]) for (const i of [0, 1]) {
                const f = pdfFileFor(this._fontManifest, fam, b, i);
                if (f) need.add(f);
            }
        }

        for (const f of need) {
            try {
                if (!this._fontBytes[f]) {
                    const r = await fetch(PDF_FONTS_BASE + '/' + f + '.ttf');
                    if (!r.ok) continue;
                    this._fontBytes[f] = await r.arrayBuffer();
                }
                this._pdfFont[f] = await pdf.embedFont(this._fontBytes[f], { subset: true });
            } catch (e) { /* pomiń wadliwy krój — zadziała fallback */ }
        }
        if (!this._pdfFont['gelasio-400']) throw new Error('Brak bazowego kroju.');
    }

    pdfFontFor(family, bold, italic) {
        const f = pdfFileFor(this._fontManifest, family || 'Georgia', bold, italic);
        return (f && this._pdfFont[f]) || this._pdfFont['gelasio-400'];
    }

    pdfRgb(hex) { const c = hexToRgb01(hex); return window.PDFLib.rgb(c.r, c.g, c.b); }

    /** Osadza wszystkie obrazy/ikony dokumentu (z kadrem) jako PNG/JPEG — raz, z cache po src+kadr. */
    async pdfEmbedAllImages(pdf) {
        this._pdfImg = {};
        for (const box of this.doc.pages) for (const el of (box.elements || [])) {
            if (el.type !== 'image' && el.type !== 'icon') continue;
            const key = this.pdfImgKey(el);
            if (this._pdfImg[key] !== undefined) continue;
            try {
                const enc = await this.pdfImageData(el);
                this._pdfImg[key] = enc ? (enc.jpeg ? await pdf.embedJpg(enc.url) : await pdf.embedPng(enc.url)) : null;
            } catch (e) { this._pdfImg[key] = null; }
        }
    }

    pdfImgKey(el) {
        const f = el.fit ? `f:${el.fit.x},${el.fit.y},${el.fit.width},${el.fit.height}` : '';
        const c = el.crop ? `c:${el.crop.x},${el.crop.y},${el.crop.width},${el.crop.height}` : '';
        const wh = `${el.width || ''}x${el.height || ''}`;
        const r = `r:${el.cornerRadius || 0}`;
        const s = `s:${el.frameShape || 'rect'}`;
        const st = `st:${el.frameStyle || 'none'}:${el.frameStyleIntensity != null ? el.frameStyleIntensity : 50}`;
        // Sygnatura customPath = liczba punktów + suma kontrolna współrzędnych (zaokrąglone).
        const cp = (el.frameShape === 'custom' && Array.isArray(el.customPath))
            ? `cp:${el.customPath.length}/${el.customPath.map((p) => Math.round((p[0] || 0) * 1e4) + ',' + Math.round((p[1] || 0) * 1e4)).join(';')}`
            : '';
        return (el.type) + '|' + (el.src || '') + '|' + wh + '|' + f + c + '|' + r + '|' + s + '|' + st + '|' + cp;
    }

    /** Rasteryzuje obraz/ikonę do PDF — z uwzględnieniem el.fit (lub legacy el.crop).
     *  Canvas ma rozmiar ramki (el.width × el.height) × scale jakości; obraz rysowany w pozycji fit.
     *  Obszar canvas poza obrazem zostaje przezroczysty → ramka pokazuje tło strony.
     */
    async pdfImageData(el) {
        let img = this.imageCache[el.src];
        if (!img) img = this.getImage(el.src);
        if (!img.complete || !img.naturalWidth) {
            await new Promise((res) => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); setTimeout(res, 4000); });
        }
        if (!img.naturalWidth) return null;

        // Ikony — bez kadru, prosty render w wysokiej rozdzielczości.
        if (el.type === 'icon') {
            const sc = 4;
            const cw = Math.max(8, Math.round((el.width || 64) * sc));
            const ch = Math.max(8, Math.round((el.height || 64) * sc));
            const cv = document.createElement('canvas');
            cv.width = cw; cv.height = ch;
            cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
            return { url: cv.toDataURL('image/png'), jpeg: false };
        }

        // Image: canvas o wymiarze ramki, obraz w pozycji `fit` w przestrzeni ramki.
        const fit = this.computeImageFit(el, img);
        const W = el.width || 1, H = el.height || 1;
        const cap = 2400, scale = Math.min(4, cap / Math.max(W, H));
        const cw = Math.max(1, Math.round(W * scale));
        const ch = Math.max(1, Math.round(H * scale));
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // Zaokrąglone rogi ramki LUB niestandardowy kształt LUB styl brush/torn → clip canvasu do ścieżki przed drawImage.
        const radius = Math.max(0, Math.min(Math.min(W, H) / 2, el.cornerRadius || 0)) * scale;
        const fshape = el.frameShape || 'rect';
        const fstyle = el.frameStyle || 'none';
        const customShape = (fshape !== 'rect');
        const usePerturbed = (fstyle === 'brush' || fstyle === 'torn');
        const useFade = (fstyle === 'fade');
        const usePaint = (fstyle === 'paint');
        const useStampClip = (fstyle === 'stamp');
        const useBrushFrameClip = (fstyle === 'brushframe');
        const needsClip = customShape || radius > 0.5 || usePerturbed || useStampClip || useBrushFrameClip;
        if (needsClip) {
            ctx.save();
            ctx.beginPath();
            if (useStampClip) {
                // Stempelek: clip do perforowanego konturu — w „dziurach" perforacji brak obrazu.
                gzStampOutlinePath(ctx, 0, 0, cw, ch);
            } else if (useBrushFrameClip) {
                // Ramka pędzlowa: clip do perturbowanego konturu zewn. — w wyszczerbieniach brak obrazu.
                gzBrushFrameOuterPath(ctx, cw, ch, el);
            } else if (usePerturbed) {
                // Perturbowany kształt — ta sama funkcja co w edytorze, te same wymiary canvas → identyczny wynik.
                gzPerturbedShapePath(ctx, fshape, 0, 0, cw, ch, el, fstyle);
            } else if (fshape === 'rect') {
                gzRoundedRectPath(ctx, 0, 0, cw, ch, radius);
            } else {
                gzDrawShape(ctx, fshape, 0, 0, cw, ch, el);
            }
            ctx.clip();
        }
        ctx.drawImage(
            img,
            0, 0, img.naturalWidth, img.naturalHeight,
            fit.x * scale, fit.y * scale, fit.width * scale, fit.height * scale
        );
        if (needsClip) { ctx.restore(); }

        // STYL „fade" — vignette przez canvas globalCompositeOperation = destination-out.
        if (useFade) {
            const intMul = _gzStyleIntensity(el);
            const cx = cw / 2, cy = ch / 2;
            const ms = Math.min(cw, ch);
            const rIn  = ms * Math.max(0.05, 0.50 - intMul * 0.15);
            const rOut = ms * Math.min(0.95, 0.50 + intMul * 0.13);
            const grad = ctx.createRadialGradient(cx, cy, rIn, cx, cy, rOut);
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(1, 'rgba(0,0,0,1)');
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, cw, ch);
            ctx.globalCompositeOperation = 'source-over';
        }
        // STYL „paint" — maska radialnego pędzla via destination-in. Ten sam mask co Konva.
        if (usePaint) {
            const maskCv = gzPaintedMaskCanvas(cw, ch, el);
            ctx.globalCompositeOperation = 'destination-in';
            ctx.drawImage(maskCv, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
        }
        // DEKORACYJNE RAMKI — overlay po obrazie (stempelek, złota rama, ramka pędzlowa).
        const useDecorative = (fstyle === 'stamp' || fstyle === 'frame' || fstyle === 'brushframe');
        if (useDecorative) {
            if (fstyle === 'stamp') { gzDrawStampFrameRing(ctx, cw, ch, el); }
            else if (fstyle === 'frame') { gzDrawPictureFrameRing(ctx, cw, ch, el); }
            else { gzDrawBrushFrameRing(ctx, cw, ch, el); }
        }

        // Decyzja JPEG/PNG: PNG gdy obraz nie wypełnia całej ramki (przezroczyste pole),
        // ma cień, ma zaokrąglone rogi, niestandardowy kształt, lub jakikolwiek styl krawędzi.
        const coversFrame = (fit.x <= 0.5 && fit.y <= 0.5
            && fit.x + fit.width >= W - 0.5
            && fit.y + fit.height >= H - 0.5);
        const usePng = !coversFrame || !!el.shadow || (el.cornerRadius || 0) > 0.5
                       || customShape || usePerturbed || useFade || usePaint || useDecorative;
        const jpeg = !usePng && /\.jpe?g($|\?)/i.test(el.src || '');
        return { url: jpeg ? cv.toDataURL('image/jpeg', 0.92) : cv.toDataURL('image/png'), jpeg };
    }

    /** Wykonuje fn() w kontekście obróconym wokół TL elementu (rot Konva CW ↔ PDF CCW, Y flip). */
    pdfWithRotation(page, el, ox, oy, fn) {
        if (!el.rotation) { fn(); return; }
        const L = window.PDFLib;
        if (!L || !L.pushGraphicsState || !L.translate || !L.rotateDegrees || !page.pushOperators) {
            fn(); return; // fallback bez rotacji
        }
        const pivotX = ox + el.x;
        const pivotY = oy + this.pageH - el.y;
        page.pushOperators(
            L.pushGraphicsState(),
            L.translate(pivotX, pivotY),
            L.rotateDegrees(-el.rotation), // Konva CW → PDF CCW
            L.translate(-pivotX, -pivotY),
        );
        try { fn(); } finally { page.pushOperators(L.popGraphicsState()); }
    }

    /** Rysuje całą stronę dokumentu na stronie PDF z offsetem (ox,oy w pt, układ od lewego-dolnego rogu obszaru). */
    pdfDrawPage(page, box, ox, oy, pageIndex) {
        page.drawRectangle({ x: ox, y: oy, width: this.pageW, height: this.pageH, color: this.pdfRgb(box.background || '#ffffff') });
        for (const el of (box.elements || [])) {
            if (el.hidden) { continue; } // ukryta warstwa — nie do PDF
            const top = oy + this.pageH - (el.y + (el.height || 0)); // dolna krawędź elementu w układzie PDF
            this.pdfWithRotation(page, el, ox, oy, () => this.pdfDrawElement(page, el, ox, oy, top, box));
        }
        this.pdfDrawPageNumber(page, ox, oy, pageIndex);
    }

    /** Rysuje pojedynczy element strony (po opcjonalnej rotacji canvas). */
    pdfDrawElement(page, el, ox, oy, top, box) {
        // Krycie (opacity) — wspólne dla wszystkich draw-calls poniżej. Domyślnie 1.
        const op = (el.opacity != null) ? el.opacity : 1;
        if (el.type === 'rect') {
                this.pdfRect(page, ox + el.x, top, el.width, el.height, Math.max(0, el.cornerRadius || 0), {
                    fill: el.fill || '#e9eef5',
                    stroke: (el.stroke && (el.strokeWidth || 0) > 0) ? el.stroke : null,
                    strokeWidth: el.strokeWidth || 0,
                    opacity: op,
                    gradient: rectGradientConfig(el) ? {
                        type: el.gradientType,
                        from: el.gradientFrom || '#e9eef5',
                        to: el.gradientTo || '#1a56db',
                        angle: el.gradientAngle || 0,
                    } : null,
                });
            } else if (el.type === 'line') {
                page.drawLine({ start: { x: ox + el.x, y: oy + this.pageH - el.y }, end: { x: ox + el.x + el.width, y: oy + this.pageH - el.y }, thickness: el.strokeWidth || 2, color: this.pdfRgb(el.stroke || '#1a2330'), opacity: op });
            } else if (el.type === 'image' || el.type === 'icon') {
                const im = this._pdfImg[this.pdfImgKey(el)];
                if (im) page.drawImage(im, { x: ox + el.x, y: top, width: el.width, height: el.height, opacity: op });
            } else if (el.type === 'text') {
                this.pdfDrawTextEl(page, el, box.elements, ox, oy, op);
            }
    }

    /** Prostokąt PDF z opcjonalnym zaokrągleniem rogów i opcjonalnym gradientem (aproksymacja paskami). */
    pdfRect(page, x, bottomY, w, h, r, opts) {
        const op = (opts.opacity != null) ? opts.opacity : 1;
        // Gradient: pdf-lib nie ma natywnego gradientu — rysuję aproksymację (linear=paski w kierunku kąta, radial=koncentryczne kwadraty).
        if (opts.gradient) {
            this.pdfDrawGradientRect(page, x, bottomY, w, h, r, opts.gradient, op);
            // obramowanie nakładamy na koniec
            if (opts.stroke && (opts.strokeWidth || 0) > 0) {
                const o = { borderColor: this.pdfRgb(opts.stroke), borderWidth: opts.strokeWidth, opacity: op, borderOpacity: op };
                if (r > 0.5) { page.drawSvgPath(pdfRoundedRectPath(w, h, r), { x, y: bottomY + h, ...o }); }
                else { page.drawRectangle({ x, y: bottomY, width: w, height: h, ...o }); }
            }
            return;
        }
        const o = { opacity: op, borderOpacity: op };
        if (opts.fill) o.color = this.pdfRgb(opts.fill);
        if (opts.stroke && (opts.strokeWidth || 0) > 0) { o.borderColor = this.pdfRgb(opts.stroke); o.borderWidth = opts.strokeWidth; }
        if (r > 0.5) {
            page.drawSvgPath(pdfRoundedRectPath(w, h, r), { x, y: bottomY + h, ...o }); // y = górna krawędź (oś SVG w dół)
        } else {
            page.drawRectangle({ x, y: bottomY, width: w, height: h, ...o });
        }
    }

    /** Aproksymacja gradientu: 100 cienkich pasów (linear) lub 100 koncentrycznych prostokątów (radial). */
    pdfDrawGradientRect(page, x, bottomY, w, h, r, g, opacity = 1) {
        const SAVE = page.pushOperators ? false : false; // (pdf-lib nie ma trywialnego clipu; gradient rysujemy w obrębie prostokąta i tyle — radius pociemnia się tylko wewnątrz)
        const steps = 100;
        const op = opacity;
        if (g.type === 'linear') {
            // przeliczam kierunek pasów: pasy prostopadłe do wektora gradientu
            const ang = ((g.angle || 0) % 360) * Math.PI / 180;
            const dx = Math.cos(ang), dy = Math.sin(ang);
            // długość projekcji rozmiaru prostokąta na kierunek
            const len = Math.abs(dx) * w + Math.abs(dy) * h;
            // Strategia: rysuję paski wzdłuż osi „mniej zmiennej" by uprościć geometrię.
            // Najprostsze i wystarczająco wierne: jeśli |dx|>=|dy| → paski pionowe; inaczej poziome; potem stripowanie po szerokości/wysokości.
            if (Math.abs(dx) >= Math.abs(dy)) {
                const sw = w / steps;
                for (let i = 0; i < steps; i++) {
                    const t = (i + 0.5) / steps; // 0..1 wzdłuż X
                    const tt = (dx >= 0) ? t : (1 - t);
                    const c = this.pdfRgb(lerpColorHex(g.from, g.to, tt));
                    // delikatne nakładanie 1 px, by nie pojawił się szew
                    page.drawRectangle({ x: x + i * sw, y: bottomY, width: sw + 0.5, height: h, color: c, opacity: op });
                }
            } else {
                const sh = h / steps;
                for (let i = 0; i < steps; i++) {
                    const t = (i + 0.5) / steps;
                    // i=0 to dolny pas; gradient idzie od „góry do dołu" przy angle=90 (Konva y+ w dół);
                    // by zachować spójność z ekranem: dla dy>0 (kąt 90°) kolor 'from' jest na górze, więc dolny pas (i=0 w naszym układzie PDF) to 'to'.
                    const tt = (dy >= 0) ? (1 - t) : t;
                    const c = this.pdfRgb(lerpColorHex(g.from, g.to, tt));
                    page.drawRectangle({ x, y: bottomY + i * sh, width: w, height: sh + 0.5, color: c, opacity: op });
                }
            }
        } else if (g.type === 'radial') {
            // wypełniamy tłem (kolor 'to'), potem rysujemy malejące koncentryczne prostokąty kolorem coraz bliżej 'from'
            page.drawRectangle({ x, y: bottomY, width: w, height: h, color: this.pdfRgb(g.to), opacity: op });
            const cx = x + w / 2, cy = bottomY + h / 2;
            // skalowanie: największy „promień" = pół przekątnej
            const maxR = Math.sqrt((w / 2) * (w / 2) + (h / 2) * (h / 2));
            for (let i = steps - 1; i >= 1; i--) {
                const t = i / steps; // 1..0 (od krawędzi do środka)
                const c = this.pdfRgb(lerpColorHex(g.from, g.to, t));
                const ratio = i / steps; // promień jako frakcja
                const rw = w * ratio, rh = h * ratio;
                page.drawRectangle({ x: cx - rw / 2, y: cy - rh / 2, width: rw, height: rh, color: c, opacity: op });
            }
        }
    }

    pdfDrawPageNumber(page, ox, oy, pageIndex) {
        const pn = this.doc.pageNumbers;
        if (!pn || !pn.show) return;
        const num = pageIndex + 1, fontSize = 11, marginX = 32, marginBottom = 22;
        const font = this.pdfFontFor('Georgia', false, false);
        const txt = String(num);
        const tw = font.widthOfTextAtSize(txt, fontSize);
        let x;
        if (pn.position === 'outer') x = (num % 2 === 1) ? (ox + this.pageW - marginX - tw) : (ox + marginX);
        else x = ox + (this.pageW - tw) / 2;
        const yTop = this.pageH - marginBottom - fontSize;
        page.drawText(txt, { x, y: oy + this.pageH - (yTop + fontSize * PDF_ASCENT), size: fontSize, font, color: this.pdfRgb('#555555') });
    }

    /** Rysuje ramkę tekstu (tło/obramowanie + tekst) — szpalty, justowanie, valign, runs, oblewanie z obu stron. */
    pdfDrawTextEl(page, el, els, ox, oy, opacity = 1) {
        const rad = Math.max(0, el.bgRadius || 0);
        if (el.bgOn && (el.bgFill || el.bgGradientType)) {
            const opts = { fill: el.bgFill || '#ffffff', opacity };
            if (textBgGradientConfig(el)) {
                opts.gradient = {
                    type: el.bgGradientType,
                    from: el.bgGradientFrom || '#e9eef5',
                    to:   el.bgGradientTo   || '#1a56db',
                    angle: el.bgGradientAngle || 0,
                };
            }
            this.pdfRect(page, ox + el.x, oy + this.pageH - (el.y + el.height), el.width, el.height, rad, opts);
        }
        if (el.borderOn && (el.borderWidth || 0) > 0) {
            const sw = el.borderWidth;
            this.pdfRect(page, ox + el.x + sw / 2, oy + this.pageH - (el.y + el.height) + sw / 2, el.width - sw, el.height - sw, Math.max(0, rad - sw / 2), { stroke: el.borderColor || '#1a56db', strokeWidth: sw, opacity });
        }
        const pad = Math.max(0, el.padding || 0);
        const inner = pad > 0 ? Object.assign({}, el, { width: Math.max(8, el.width - 2 * pad), height: Math.max(8, el.height - 2 * pad) }) : el;
        const cols = clamp(inner.columns || 1, 1, 3);
        const lineHpx = (inner.fontSize || 14) * (inner.lineHeight || 1.3);
        const gap = inner.columnGap ?? 14;
        const colW = cols === 1 ? inner.width : (inner.width - gap * (cols - 1)) / cols;
        const align = inner.align || 'left';
        const valign = el.valign || 'top';
        const ex = !el.rotation ? this.imageExclusions(el, els) : [];

        this._pctx = { ox: ox + el.x + pad, oyB: oy, top: el.y + pad, opacity };
        if (ex.length) {
            const exAdj = pad > 0
                ? ex.map((e) => Object.assign({}, e, {
                    x0: e.x0 - pad, x1: e.x1 - pad, y0: e.y0 - pad, y1: e.y1 - pad,
                    imgX: (e.imgX ?? 0) - pad, imgY: (e.imgY ?? 0) - pad,
                }))
                : ex;
            this.pdfRenderFlowed(page, inner, exAdj, lineHpx, align, cols, colW, gap);
        } else {
            this.pdfRenderColumns(page, inner, cols, colW, gap, lineHpx, align, valign);
        }
    }

    pdfMeasureWord(word, el) {
        const ls = this.letterSpacingFor(el, word._para || 0);
        let w = 0, chars = 0;
        for (const sg of word.segs) {
            const sz = (sg.size || el.fontSize || 14);
            w += this.pdfFontFor(el.fontFamily, sg.bold, sg.italic).widthOfTextAtSize(sg.text, sz);
            chars += [...sg.text].length;
        }
        if (ls && chars > 1) { w += ls * (chars - 1); }
        word._w = w; return w;
    }

    pdfSpaceW(el) {
        const f = this.pdfFontFor(el.fontFamily, false, false);
        return f.widthOfTextAtSize(' ', el.fontSize || 14) || (el.fontSize || 14) * 0.28;
    }

    /** Rysuje słowo z baseline + per-akapit letter-spacing. */
    pdfDrawWord(page, word, el, x, yTop, baseline) {
        const c = this._pctx;
        const bl = baseline != null ? baseline : ((el.fontSize || 14) * 0.80);
        const baseCol = el.fill || '#1a2330';
        const ls = this.letterSpacingFor(el, word._para || 0);
        const op = (c && c.opacity != null) ? c.opacity : 1;
        let cx = c.ox + x;
        for (const sg of word.segs) {
            const sz = sg.size || (el.fontSize || 14);
            const col = this.pdfRgb(sg.color || baseCol);
            const f = this.pdfFontFor(el.fontFamily, sg.bold, sg.italic);
            const baselineY = c.oyB + this.pageH - (c.top + yTop + bl);
            const drawOpts = { x: cx, y: baselineY, size: sz, font: f, color: col, opacity: op };
            if (ls) { drawOpts.characterSpacing = ls; }
            page.drawText(sg.text, drawOpts);
            const chars = [...sg.text].length;
            cx += f.widthOfTextAtSize(sg.text, sz) + (ls && chars > 0 ? ls * chars : 0);
        }
    }

    /** Per-line lineH i baseline (max segment size × lineHeight ratio, ascent ≈ 0.80). */
    pdfWrapRich(paras, colW, el) {
        const sp = this.pdfSpaceW(el);
        const lh = el.lineHeight || 1.3;
        const baseSize = el.fontSize || 14;
        const lines = [];
        const finalize = (line) => {
            let maxSize = baseSize;
            for (const w of line.words) {
                for (const s of w.segs) {
                    const sz = s.size || baseSize;
                    if (sz > maxSize) { maxSize = sz; }
                }
            }
            line.lineH = maxSize * lh;
            line.baseline = maxSize * 0.80;
            lines.push(line);
        };
        for (let pi = 0; pi < paras.length; pi++) {
            const words = paras[pi];
            if (!words.length) { finalize({ words: [], lastOfPara: true, paraIndex: pi }); continue; }
            let line = [], w = 0;
            for (let wi = 0; wi < words.length; wi++) {
                const word = words[wi];
                const ww = this.pdfMeasureWord(word, el);
                const add = (line.length ? sp : 0) + ww;
                if (w + add <= colW) { line.push(word); w += add; continue; }
                // Spróbuj dzielenia polskimi regułami.
                if (line.length > 0) {
                    const avail = colW - w - sp;
                    const split = this.pdfTrySplitWord(word, avail, el);
                    if (split) {
                        line.push(split.head); finalize({ words: line, lastOfPara: false, paraIndex: pi });
                        words.splice(wi + 1, 0, split.tail);
                        line = []; w = 0; continue;
                    }
                    finalize({ words: line, lastOfPara: false, paraIndex: pi });
                    line = []; w = 0;
                }
                if (ww > colW) {
                    const split = this.pdfTrySplitWord(word, colW, el);
                    if (split) {
                        line.push(split.head); finalize({ words: line, lastOfPara: false, paraIndex: pi });
                        words.splice(wi + 1, 0, split.tail);
                        line = []; w = 0; continue;
                    }
                }
                line.push(word); w = ww;
            }
            finalize({ words: line, lastOfPara: true, paraIndex: pi });
        }
        return { lines, sp };
    }

    /** Analogiczne dzielenie polskimi regułami dla PDF — używa metryk pdf-lib zamiast canvas. */
    pdfTrySplitWord(word, availW, el) {
        if (!word || !word.segs || word.segs.length !== 1) { return null; }
        const seg = word.segs[0];
        const text = seg.text || '';
        const parts = this.hyphenateWord(text);
        if (!parts || parts.length < 2) { return null; }
        const sz = seg.size || (el.fontSize || 14);
        const font = this.pdfFontFor(el.fontFamily, seg.bold, seg.italic);
        let acc = '';
        let cut = -1;
        for (let k = 0; k < parts.length - 1; k++) {
            acc += parts[k];
            const prefixW = font.widthOfTextAtSize(acc + '-', sz);
            if (prefixW <= availW + 0.5) { cut = k + 1; }
            else { break; }
        }
        if (cut <= 0) { return null; }
        const headSeg = { ...seg, text: parts.slice(0, cut).join('') + '-' };
        const tailSeg = { ...seg, text: parts.slice(cut).join('') };
        return { head: { segs: [headSeg] }, tail: { segs: [tailSeg] } };
    }

    pdfRenderLine(page, line, el, cx, y, colW, sp, align, isLastVisible) {
        const ws = line.words;
        const wd = ws.map((w) => (w._w != null ? w._w : this.pdfMeasureWord(w, el)));
        const nat = wd.reduce((a, b) => a + b, 0) + sp * (ws.length - 1);
        const bl = line.baseline || ((el.fontSize || 14) * 0.80);
        if (align === 'justify' && !isLastVisible && !line.lastOfPara && ws.length > 1 && nat >= colW * 0.5) {
            const extra = (colW - nat) / (ws.length - 1);
            let x = cx;
            for (let k = 0; k < ws.length; k++) { this.pdfDrawWord(page, ws[k], el, x, y, bl); x += wd[k] + sp + extra; }
            return;
        }
        let x = cx;
        if (align === 'center') x = cx + (colW - nat) / 2;
        else if (align === 'right') x = cx + (colW - nat);
        for (let k = 0; k < ws.length; k++) { this.pdfDrawWord(page, ws[k], el, x, y, bl); x += wd[k] + sp; }
    }

    pdfRenderColumns(page, el, cols, colW, gap, lineHpx, align, valign) {
        const { lines, sp } = this.pdfWrapRich(this.richWords(el), colW, el);
        // Posklejaj linie do kolumn na podstawie ich wysokości (per-linia lineH).
        const colsLines = Array.from({ length: cols }, () => []);
        let colIdx = 0, colH = 0;
        for (let li = 0; li < lines.length; li++) {
            const ln = lines[li];
            const lnH = ln.lineH || lineHpx;
            if (colH + lnH > el.height + 1 && colsLines[colIdx].length > 0) {
                colIdx++; colH = 0;
                if (colIdx >= cols) { break; }
            }
            colsLines[colIdx].push(ln); colH += lnH;
        }
        for (let c = 0; c < cols; c++) {
            const cx = c * (colW + gap);
            const colsArr = colsLines[c];
            if (!colsArr.length) { continue; }
            const colContentH = colsArr.reduce((a, l) => a + (l.lineH || lineHpx), 0);
            let yOff = 0;
            if (valign === 'middle') { yOff = Math.max(0, (el.height - colContentH) / 2); }
            else if (valign === 'bottom') { yOff = Math.max(0, el.height - colContentH); }
            let yCur = yOff;
            const lastIdx = colsArr.length - 1;
            for (let i = 0; i < colsArr.length; i++) {
                const ln = colsArr[i];
                const lnH = ln.lineH || lineHpx;
                if (ln.words.length) {
                    this.pdfRenderLine(page, ln, el, cx, yCur, colW, sp,
                        this.paraAlignOf(el, ln.paraIndex, align),
                        (c === cols - 1 && i === lastIdx));
                }
                yCur += lnH;
            }
        }
    }

    pdfRenderFlowed(page, el, exclusions, lineHpx, align, cols, colW, gap) {
        const sp = this.pdfSpaceW(el);
        const frameH = el.height;
        const colX = (c) => c * (colW + gap);
        const minSegW = Math.max(32, (el.fontSize || 14) * 2.2);
        let col = 0, y = 0, overflow = false;
        const ensureRoom = () => { while (y + lineHpx > frameH + 1) { col++; y = 0; if (col >= cols) return false; } return true; };
        const paras = this.richWords(el);
        for (let p = 0; p < paras.length && !overflow; p++) {
            const words = paras[p];
            const pAlign = this.paraAlignOf(el, p, align);
            if (!words.length) { if (!ensureRoom()) { overflow = true; break; } y += lineHpx; continue; }
            let i = 0;
            while (i < words.length) {
                if (!ensureRoom()) { overflow = true; break; }
                const cx0 = colX(col);
                const segs = this.freeIntervalsInRange(y, y + lineHpx, cx0, cx0 + colW, exclusions, minSegW);
                if (!segs.length) { y += lineHpx; continue; }
                for (let s = 0; s < segs.length && i < words.length; s++) {
                    const seg = segs[s], availW = seg[1] - seg[0], fullWidth = availW >= colW - 0.5;
                    const lineWords = []; let w = 0;
                    while (i < words.length) {
                        const wordW = this.pdfMeasureWord(words[i], el);
                        const add = (lineWords.length ? sp : 0) + wordW;
                        if (w + add > availW) {
                            if (lineWords.length > 0) {
                                const splitAvail = availW - w - sp;
                                const split = this.pdfTrySplitWord(words[i], splitAvail, el);
                                if (split) {
                                    lineWords.push(split.head);
                                    w += sp + this.pdfMeasureWord(split.head, el);
                                    words.splice(i + 1, 0, split.tail);
                                    i++;
                                    break;
                                }
                            }
                            if (lineWords.length === 0 && fullWidth) { lineWords.push(words[i]); w += add; i++; }
                            break;
                        }
                        lineWords.push(words[i]); w += add; i++;
                    }
                    if (!lineWords.length) continue;
                    const moreWords = i < words.length;
                    this.pdfRenderLine(page, { words: lineWords, lastOfPara: !moreWords }, el, seg[0], y, availW, sp, pAlign, !moreWords);
                }
                y += lineHpx;
            }
        }
    }

    downloadBlob(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    // ─── Projekt: zapis do pliku / wczytanie z pliku (z grafikami) ───

    /** Zapisuje całą gazetkę do jednego pliku .gazetka.json z WBUDOWANYMI zdjęciami/grafikami (data URI). */
    async exportProject() {
        this.statusTarget.textContent = 'Przygotowuję plik projektu…';
        try {
            if (this.dirty) await this.save();
            await this.preloadAllImages();
            const doc = JSON.parse(JSON.stringify(this.doc));

            // Zbierz unikalne źródła grafik i zamień URL-e uploadów na data URI (ikony są już data URI).
            const srcs = new Set();
            for (const p of doc.pages) for (const el of (p.elements || [])) {
                if ((el.type === 'image' || el.type === 'icon') && el.src) srcs.add(el.src);
            }
            const map = {};
            for (const src of srcs) {
                if (src.startsWith('data:')) { map[src] = src; continue; }
                try { map[src] = await this.urlToDataUri(src); } catch (e) { map[src] = src; }
            }
            for (const p of doc.pages) for (const el of (p.elements || [])) {
                if ((el.type === 'image' || el.type === 'icon') && el.src && map[el.src]) el.src = map[el.src];
            }

            const title = this.titleTarget.value || 'gazetka';
            const bundle = { format: 'gazetka-bundle', version: 1, title, pageCount: doc.pages.length, savedAt: new Date().toISOString(), doc };
            const fname = title.replace(/[^\p{L}\p{N}_-]+/gu, '_') + '.gazetka.json';
            this.downloadBlob(new Blob([JSON.stringify(bundle)], { type: 'application/json' }), fname);
            this.statusTarget.textContent = 'Zapisano projekt do pliku: ' + fname;
        } catch (e) {
            this.statusTarget.textContent = 'Błąd zapisu projektu: ' + e.message;
            console.error(e);
        }
    }

    /** Pobiera URL (same-origin) i zwraca jego zawartość jako data URI. */
    urlToDataUri(url) {
        return fetch(url)
            .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
            .then((blob) => new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.onerror = reject;
                fr.readAsDataURL(blob);
            }));
    }

    pickProjectFile() {
        if (this.hasProjectFileTarget) this.projectFileTarget.click();
    }

    /** Wczytuje plik .gazetka: tworzy NOWĄ gazetkę, wgrywa grafiki po jednej i zapisuje dokument. */
    async onProjectChosen(event) {
        const input = event.target;
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        this.statusTarget.textContent = 'Wczytuję projekt…';
        try {
            const bundle = JSON.parse(await file.text());
            const doc = bundle && bundle.doc;
            if (!bundle || bundle.format !== 'gazetka-bundle' || !doc || !Array.isArray(doc.pages)) {
                throw new Error('To nie jest plik projektu gazetki.');
            }

            // 1) Utwórz nową, pustą gazetkę (osobną — bieżąca zostaje nietknięta).
            const crRes = await fetch(this.importCreateUrlValue, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ title: bundle.title || 'Gazetka (import)', pageCount: doc.pages.length }),
            });
            const cr = await crRes.json();
            if (!cr.ok) throw new Error(cr.error || 'Nie udało się utworzyć gazetki.');

            // 2) Wgraj wbudowane zdjęcia (data: png/jpeg/webp/gif) po jednej — ikony (svg data URI) zostają.
            const photos = new Set();
            for (const p of doc.pages) for (const el of (p.elements || [])) {
                if (el.type === 'image' && typeof el.src === 'string' && /^data:image\/(png|jpe?g|webp|gif)/i.test(el.src)) photos.add(el.src);
            }
            const map = {};
            let done = 0;
            for (const src of photos) {
                this.statusTarget.textContent = 'Wgrywam grafiki… (' + (++done) + '/' + photos.size + ')';
                map[src] = await this.uploadDataUri(cr.uploadUrl, src);
            }
            for (const p of doc.pages) for (const el of (p.elements || [])) {
                if (el.type === 'image' && el.src && map[el.src]) el.src = map[el.src];
            }

            // 3) Zapisz dokument (już lekki — z URL-ami) do nowej gazetki i otwórz ją.
            const svRes = await fetch(cr.saveUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ doc, title: bundle.title || 'Gazetka (import)' }),
            });
            const sv = await svRes.json();
            if (!sv.ok) throw new Error(sv.error || 'Nie udało się zapisać dokumentu.');

            this.statusTarget.textContent = 'Wczytano — otwieram nową gazetkę…';
            window.location = cr.editUrl;
        } catch (e) {
            this.statusTarget.textContent = 'Błąd wczytywania: ' + e.message;
            alert('Nie udało się wczytać projektu: ' + e.message);
        }
    }

    /** Wgrywa pojedynczą grafikę z data URI przez endpoint uploadu (multipart) i zwraca jej URL. */
    // ─── Pojedyncza strona: eksport / import ───

    /** Zapisuje bieżącą stronę do pliku .gazetka-page (osadzone grafiki jako data URI). */
    async exportCurrentPage() {
        this.statusTarget.textContent = 'Przygotowuję plik strony…';
        try {
            if (this.dirty) { await this.save(); }
            await this.preloadAllImages();
            const srcPage = this.doc.pages[this.current];
            const page = JSON.parse(JSON.stringify(srcPage));

            // Zamień URL-e uploadów na data URI (ikony już są data URI).
            const srcs = new Set();
            for (const el of (page.elements || [])) {
                if ((el.type === 'image' || el.type === 'icon') && el.src) { srcs.add(el.src); }
            }
            const map = {};
            for (const src of srcs) {
                if (src.startsWith('data:')) { map[src] = src; continue; }
                try { map[src] = await this.urlToDataUri(src); } catch (_) { map[src] = src; }
            }
            for (const el of (page.elements || [])) {
                if ((el.type === 'image' || el.type === 'icon') && el.src && map[el.src]) { el.src = map[el.src]; }
            }

            const title = (this.titleTarget.value || 'gazetka').trim();
            const bundle = {
                format: 'gazetka-page', version: 1,
                title, pageIndex: this.current + 1,
                pageW: this.pageW, pageH: this.pageH,
                savedAt: new Date().toISOString(),
                page,
            };
            const safeTitle = title.replace(/[^\p{L}\p{N}_-]+/gu, '_');
            const fname = `${safeTitle}_str-${this.current + 1}.gazetka-page.json`;
            this.downloadBlob(new Blob([JSON.stringify(bundle)], { type: 'application/json' }), fname);
            this.statusTarget.textContent = 'Zapisano stronę do pliku: ' + fname;
        } catch (e) {
            this.statusTarget.textContent = 'Błąd zapisu strony: ' + e.message;
            console.error(e);
        }
    }

    pickPageFile() {
        if (this.hasPageFileTarget) { this.pageFileTarget.click(); }
    }

    /** Wczytuje plik .gazetka-page i WSTAWIA stronę za bieżącą (grafiki idą do uploadów tej gazetki). */
    async onPageChosen(event) {
        const input = event.target;
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) { return; }
        this.statusTarget.textContent = 'Wczytuję stronę…';
        try {
            const bundle = JSON.parse(await file.text());
            if (!bundle || bundle.format !== 'gazetka-page' || !bundle.page || !Array.isArray(bundle.page.elements)) {
                throw new Error('To nie jest plik pojedynczej strony gazetki.');
            }
            if (bundle.pageW && bundle.pageH && (bundle.pageW !== this.pageW || bundle.pageH !== this.pageH)) {
                const ok = confirm(
                    `Strona z pliku ma rozmiar ${bundle.pageW}×${bundle.pageH} pt, a bieżąca gazetka ${this.pageW}×${this.pageH} pt.\n`
                    + 'Wstawić mimo to? (elementy mogą wymagać przesunięcia)'
                );
                if (!ok) { this.statusTarget.textContent = 'Anulowano wczytywanie strony.'; return; }
            }

            const page = JSON.parse(JSON.stringify(bundle.page));

            // Zamień data URI obrazów (NIE ikon — ikony zostają inline) na URL-e wgrane do bieżącej gazetki.
            if (this.uploadUrlValue) {
                const seen = {};
                let idx = 0;
                for (const el of (page.elements || [])) {
                    if (el.type !== 'image' || typeof el.src !== 'string' || !el.src.startsWith('data:')) { continue; }
                    if (seen[el.src]) { el.src = seen[el.src]; continue; }
                    idx += 1;
                    this.statusTarget.textContent = `Wgrywam grafikę ${idx}…`;
                    try {
                        const url = await this.uploadDataUri(this.uploadUrlValue, el.src);
                        seen[el.src] = url; el.src = url;
                    } catch (e) {
                        console.warn('Nie udało się wgrać grafiki — zostaje jako data URI.', e);
                        // pozostawiamy data URI — strona zadziała, choć obciąży dokument
                    }
                }
            }

            // Nowe id-y dla wstawianych elementów (uniknięcie kolizji z istniejącymi).
            for (const el of (page.elements || [])) { el.id = uid(); }
            if (!page.background) { page.background = '#ffffff'; }

            // Wstaw za bieżącą stroną i przejdź na nią.
            const insertAt = this.current + 1;
            this.doc.pages.splice(insertAt, 0, page);
            this.current = insertAt;
            this.markDirty();
            this.select(null);
            this.renderThumbs();
            this.renderPage();
            this.statusTarget.textContent = `Wstawiono stronę jako ${insertAt + 1}.`;
        } catch (e) {
            this.statusTarget.textContent = 'Błąd wczytywania strony: ' + e.message;
            console.error(e);
        }
    }

    async uploadDataUri(uploadUrl, dataUri) {
        const blob = await (await fetch(dataUri)).blob();
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const fd = new FormData();
        fd.append('image', blob, 'import.' + ext);
        const res = await fetch(uploadUrl, {
            method: 'POST',
            headers: { 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
            body: fd,
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Błąd wgrywania grafiki.');
        return data.url;
    }

    // ─── Asystent AI ────────────────────────────────────────

    async generateArticle() {
        const root = this.element;
        const topic = (root.querySelector('[data-ai="topic"]').value || '').trim();
        if (!topic) { this.setAiStatus('text', 'Podaj temat artykułu.', true); return; }

        const payload = {
            topic,
            type: root.querySelector('[data-ai="type"]').value,
            details: root.querySelector('[data-ai="details"]').value,
            length: root.querySelector('[data-ai="length"]').value,
            tone: root.querySelector('[data-ai="tone"]').value,
        };
        this.setAiBusy('text', true);
        this.setAiStatus('text', 'Piszę artykuł… (zwykle 10–30 s)');
        try {
            const res = await fetch(this.aiTextUrlValue, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd generowania.');
            this.insertArticle(data);
            this.closeAiModal();
        } catch (e) {
            this.setAiStatus('text', 'Błąd: ' + e.message, true);
        } finally {
            this.setAiBusy('text', false);
        }
    }

    insertArticle(data) {
        const sel = this.selectedEl();
        // Jeśli zaznaczona jest ramka tekstu — wypełnij ją całością.
        if (sel && sel.type === 'text') {
            sel.text = (data.title ? data.title + '\n\n' : '')
                + (data.lead ? data.lead + '\n\n' : '') + (data.body || '');
            this.markDirty();
            this.renderPage();
            this.select(sel.id);
            return;
        }
        // W przeciwnym razie: nagłówek + treść w 2 szpaltach.
        const m = 36, cw = this.pageW - 2 * m;
        let y = 40;
        if (data.title) {
            this.page().elements.push({
                id: uid(), type: 'text', x: m, y, width: cw, height: 54, rotation: 0, opacity: 1,
                text: data.title, fontSize: 26, fontFamily: 'Georgia', fontStyle: 'bold',
                fill: '#0b1f3a', align: 'left', lineHeight: 1.1, columns: 1, columnGap: 14,
            });
            y = 104;
        }
        const bodyText = (data.lead ? data.lead + '\n\n' : '') + (data.body || '');
        this.page().elements.push({
            id: uid(), type: 'text', x: m, y, width: cw, height: this.pageH - y - 40, rotation: 0, opacity: 1,
            text: bodyText, fontSize: 11.5, fontFamily: 'Georgia', fontStyle: 'normal',
            fill: '#1a2330', align: 'justify', lineHeight: 1.4, columns: 2, columnGap: 16,
        });
        this.markDirty();
        this.renderPage();
        this.select(null);
    }

    /** Przy otwarciu okna AI: jeśli zaznaczono grafikę, pokaż opcję „generuj wg wzoru" z miniaturą. */
    prepareAiRef() {
        const root = this.element;
        const block = root.querySelector('[data-ai="refBlock"]');
        const chk = root.querySelector('[data-ai="refUse"]');
        const thumb = root.querySelector('[data-ai="refThumb"]');
        const promptEl = root.querySelector('[data-ai="imgPrompt"]');
        const el = this.selectedEl();

        if (block && el && el.type === 'image' && el.src) {
            this._refSrc = el.src;
            block.style.display = '';
            if (thumb) thumb.src = el.src;
            if (chk) chk.checked = true;
            if (promptEl) promptEl.placeholder = 'Nazwa działu / cyklu, np. „Sport", „Kącik czytelnika", „Z życia szkoły"';
        } else {
            this._refSrc = null;
            if (block) block.style.display = 'none';
            if (chk) chk.checked = false;
            if (promptEl) promptEl.placeholder = 'np. Jesienny park ze szkołą w tle, dzieci grające w piłkę';
        }
    }

    async generateAiImage() {
        const root = this.element;
        const prompt = (root.querySelector('[data-ai="imgPrompt"]').value || '').trim();
        const useRef = !!root.querySelector('[data-ai="refUse"]')?.checked;
        const ref = (useRef && this._refSrc) ? this._refSrc : '';
        if (!prompt && !ref) { this.setAiStatus('img', 'Opisz, co ma przedstawiać obraz.', true); return; }

        // Przy wzorze styl nadaje grafika wzorcowa — nie wysyłamy stylu z listy, by się nie „kłóciły".
        const style = ref ? '' : root.querySelector('[data-ai="imgStyle"]').value;
        this.setAiBusy('img', true);
        this.setAiStatus('img', ref ? 'Tworzę grafikę w stylu wzoru… (może potrwać do ~1 min)' : 'Generuję obraz… (może potrwać do ~1 min)');
        try {
            const res = await fetch(this.aiImageUrlValue, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ prompt, style, ref }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd generowania.');

            // Mini-winietki wstawiamy mniejsze niż zwykłą ilustrację.
            const maxW = ref ? 150 : this.pageW * 0.6;
            const maxH = ref ? 110 : this.pageH * 0.5;
            let w = data.width || 320, h = data.height || 320;
            const ratio = Math.min(maxW / w, maxH / h, 1);
            w = round(w * ratio); h = round(h * ratio);
            this.addElement({
                id: uid(), type: 'image', x: round((this.pageW - w) / 2), y: 80,
                width: w, height: h, rotation: 0, opacity: 1, src: data.url, wrapText: true, wrapGap: 9,
            });
            this.closeAiModal();
        } catch (e) {
            this.setAiStatus('img', 'Błąd: ' + e.message, true);
        } finally {
            this.setAiBusy('img', false);
        }
    }

    setAiStatus(which, msg, isError = false) {
        const el = this.element.querySelector('[data-ai="' + which + 'Status"]');
        if (el) {
            el.textContent = msg;
            el.className = 'small mb-2 ' + (isError ? 'text-danger' : 'text-secondary');
        }
    }

    setAiBusy(which, busy) {
        const btn = this.element.querySelector('[data-ai="' + which + 'Btn"]');
        if (btn) { btn.disabled = busy; btn.classList.toggle('disabled', busy); }
    }

    closeAiModal() {
        const el = document.getElementById('gzAiModal');
        const closeBtn = el && el.querySelector('[data-bs-dismiss="modal"]');
        if (closeBtn) closeBtn.click();
    }

    // ─── Kadrowanie zdjęcia ─────────────────────────────────

    setupCrop() {
        const el = this.selectedEl();
        if (!el || el.type !== 'image') return;
        const img = this.getImage(el.src);
        if (!img.complete || !img.naturalWidth) {
            img.addEventListener('load', () => this.setupCrop(), { once: true });
            return;
        }

        const K = this.Konva;
        const container = this.cropContainerTarget;
        if (this._cropStage) this._cropStage.destroy();
        container.innerHTML = '';

        const natW = img.naturalWidth, natH = img.naturalHeight;
        const maxW = Math.min(container.clientWidth || 680, 720), maxH = 460;
        const dispScale = Math.min(maxW / natW, maxH / natH, 1);
        const sw = natW * dispScale, sh = natH * dispScale;

        const stage = new K.Stage({ container, width: sw, height: sh });
        const layer = new K.Layer();
        stage.add(layer);
        layer.add(new K.Image({ image: img, width: sw, height: sh, listening: false }));
        layer.add(new K.Rect({ x: 0, y: 0, width: sw, height: sh, fill: 'black', opacity: 0.5, listening: false }));

        // Początkowy kadr: istniejący el.crop, w przeciwnym razie cały obraz.
        let cx, cy, cw, ch;
        if (el.crop && el.crop.width) {
            cx = el.crop.x; cy = el.crop.y; cw = el.crop.width; ch = el.crop.height;
        } else {
            cx = 0; cy = 0; cw = natW; ch = natH;
        }

        // Jasny fragment (kadr) leżący na przyciemnionym obrazie — „reflektor".
        const cropImg = new K.Image({ image: img, draggable: true });
        layer.add(cropImg);
        const border = new K.Rect({ stroke: '#ffffff', strokeWidth: 2, dash: [6, 4], listening: false, shadowColor: '#000', shadowBlur: 3 });
        layer.add(border);

        // Swobodne zaznaczanie dowolnego fragmentu — pełny transformer (bez obrotu).
        const tr = new K.Transformer({
            nodes: [cropImg], rotateEnabled: false, keepRatio: !!this._cropKeepRatio,
            anchorSize: 10, borderStroke: '#1a56db', anchorStroke: '#1a56db', anchorCornerRadius: 2,
            enabledAnchors: ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'],
            boundBoxFunc: (oldB, newB) => (newB.width < 16 || newB.height < 16 ? oldB : newB),
        });
        layer.add(tr);

        this._cropStage = stage;
        this._crop = { el, img, natW, natH, dispScale, cx, cy, cw, ch, cropImg, border, tr, layer, sw, sh };

        cropImg.dragBoundFunc((pos) => {
            const c = this._crop;
            const w = c.cropImg.width(), h = c.cropImg.height();
            return { x: clamp(pos.x, 0, c.sw - w), y: clamp(pos.y, 0, c.sh - h) };
        });
        cropImg.on('dragmove', () => {
            const c = this._crop;
            const x = c.cropImg.x(), y = c.cropImg.y();
            c.cx = x / c.dispScale; c.cy = y / c.dispScale;
            c.cropImg.crop({ x: c.cx, y: c.cy, width: c.cw, height: c.ch });
            c.border.setAttrs({ x, y, width: c.cropImg.width(), height: c.cropImg.height() });
            c.layer.batchDraw();
        });
        cropImg.on('transform', () => this.readCropNode());

        // Ustaw początkową geometrię węzła z modelu i dopasuj transformer.
        this.placeCropNode();
        tr.forceUpdate();
        layer.batchDraw();
    }

    /** Model (cx,cy,cw,ch w px źródła) → węzeł kadru (display) + spotlight + obwódka. */
    placeCropNode() {
        const c = this._crop;
        if (!c) return;
        c.cw = clamp(c.cw, 8, c.natW);
        c.ch = clamp(c.ch, 8, c.natH);
        c.cx = clamp(c.cx, 0, c.natW - c.cw);
        c.cy = clamp(c.cy, 0, c.natH - c.ch);
        const x = c.cx * c.dispScale, y = c.cy * c.dispScale, w = c.cw * c.dispScale, h = c.ch * c.dispScale;
        c.cropImg.setAttrs({ x, y, width: w, height: h, scaleX: 1, scaleY: 1, crop: { x: c.cx, y: c.cy, width: c.cw, height: c.ch } });
        c.border.setAttrs({ x, y, width: w, height: h });
    }

    /** Węzeł kadru po przeskalowaniu (transformer) → model. Zamienia skalę na rozmiar i przelicza na px źródła. */
    readCropNode() {
        const c = this._crop;
        if (!c) return;
        const node = c.cropImg;
        let w = Math.max(8, Math.round(node.width() * node.scaleX()));
        let h = Math.max(8, Math.round(node.height() * node.scaleY()));
        node.scaleX(1); node.scaleY(1);
        node.width(w); node.height(h);
        const x = clamp(node.x(), 0, c.sw - w), y = clamp(node.y(), 0, c.sh - h);
        node.x(x); node.y(y);
        c.cx = x / c.dispScale; c.cy = y / c.dispScale;
        c.cw = w / c.dispScale; c.ch = h / c.dispScale;
        node.crop({ x: c.cx, y: c.cy, width: c.cw, height: c.ch });
        c.border.setAttrs({ x, y, width: w, height: h });
        c.layer.batchDraw();
    }

    /** Przełącznik: czy podczas zaznaczania trzymać proporcje ramki na stronie. */
    toggleCropRatio(e) {
        this._cropKeepRatio = !!e.target.checked;
        if (this._crop && this._crop.tr) {
            this._crop.tr.keepRatio(this._cropKeepRatio);
            this._crop.layer.batchDraw();
        }
    }

    /** Liczy pozycję i wymiar obrazu w przestrzeni RAMKI (pt).
     *  Priorytet: el.fit > legacy el.crop > stretch do ramki (legacy bez crop).
     *  fit może być mniejszy LUB większy niż ramka — Group+clip obetnie wystające.
     * @returns {{x:number,y:number,width:number,height:number}}
     */
    computeImageFit(el, img) {
        const W = el.width || 0, H = el.height || 0;
        if (el.fit && el.fit.width > 0 && el.fit.height > 0) {
            return { x: el.fit.x || 0, y: el.fit.y || 0, width: el.fit.width, height: el.fit.height };
        }
        if (el.crop && el.crop.width > 0 && img && img.naturalWidth) {
            const S = W / el.crop.width;
            return {
                x: -(el.crop.x || 0) * S, y: -(el.crop.y || 0) * S,
                width: img.naturalWidth * S, height: img.naturalHeight * S,
            };
        }
        // Brak crop/fit: obraz wypełnia ramkę dokładnie (stretching — legacy default).
        return { x: 0, y: 0, width: W, height: H };
    }

    /** Picture-box in-place (Quark-style): dwuklik na obraz → edycja kadru wprost na canvasie.
     *  Ramka stoi; „ghost" pełnego obrazu wystaje poza nią. Drag środka = przesuwa obraz pod ramką.
     *  Uchwyty rogów = zoom obrazu (proporcjonalny). Klik poza ramką / Escape / Enter = zatwierdź.
     */
    editPictureBox(el, node) {
        if (!el || el.type !== 'image' || !el.src) { return; }
        if (this._customDraw || this._customEdit) { return; } // tryby rysowania/edycji kształtu mają pierwszeństwo
        if (this._picBox) { this.exitPictureBox(true); }
        const K = this.Konva;
        const img = this.getImage(el.src);
        if (!img.complete || !img.naturalWidth) {
            img.addEventListener('load', () => this.editPictureBox(el, node), { once: true });
            return;
        }
        const natW = img.naturalWidth, natH = img.naturalHeight;
        // Bieżący „fit" (pozycja+rozmiar obrazu w PRZESTRZENI RAMKI, pt). Konwertuj legacy crop, jeśli trzeba.
        const fit0 = this.computeImageFit(el, img);
        const ghostW = fit0.width, ghostH = fit0.height;
        const ghostX = el.x + fit0.x, ghostY = el.y + fit0.y;

        // Wyłącz zwykłą selekcję i zwykłego transformera w trakcie edycji picture-boxa.
        this.tr.nodes([]);
        // pełny obraz jako „ghost" na warstwie UI, ponad treścią
        const ghost = new K.Image({
            image: img, x: ghostX, y: ghostY, width: ghostW, height: ghostH,
            draggable: true, opacity: 0.55,
        });
        // klipy: obszar ramki bez ghosta-overlaya (by w ramce obraz był pełny, a poza — przygaszony)
        // Realizacja: ramka-clear (alpha 0 nad ramką) byłaby skomplikowana → idziemy prościej:
        //   nakładamy na ramkę pełny obraz na 100% alpha (sklipowany do ramki).
        // inside = obraz w ramce w pełnej intensywności; NIE łapie zdarzeń (eventy lecą do ghosta pod spodem).
        // Klip do kształtu ramki (rect|circle|ellipse|polygon-N|star-N|heart|speech|arrow-right).
        const fshape = el.frameShape || 'rect';
        const fradius = Math.max(0, Math.min(Math.min(el.width, el.height) / 2, el.cornerRadius || 0));
        const inside = new K.Group({
            clipFunc: (ctx) => {
                if (fshape === 'rect') { gzRoundedRectPath(ctx, el.x, el.y, el.width, el.height, fradius); }
                else { gzDrawShape(ctx, fshape, el.x, el.y, el.width, el.height, el); }
            },
            listening: false,
        });
        const insideImg = new K.Image({ image: img, x: ghostX, y: ghostY, width: ghostW, height: ghostH, listening: false });
        inside.add(insideImg);
        // Wizualne markery ramki (kontur kształtu). Dla rect — K.Rect; inaczej K.Path.
        const frame = (fshape === 'rect')
            ? new K.Rect({
                x: el.x, y: el.y, width: el.width, height: el.height,
                cornerRadius: fradius,
                stroke: '#1a56db', strokeWidth: 1.5, dash: [6, 4], listening: false,
            })
            : new K.Path({
                x: el.x, y: el.y,
                data: gzShapeSvgPath(fshape, el.width, el.height, el),
                stroke: '#1a56db', strokeWidth: 1.5, dash: [6, 4], listening: false,
            });
        // Picture-box jak w Quark/InDesign: obraz może być MNIEJSZY lub WIĘKSZY niż ramka.
        // Minimum praktyczne — 8 pt, by uchwyty wciąż były możliwe do złapania.
        // 4 narożniki (zoom proporcjonalny) + 4 środki krawędzi (zoom 1-osiowy, np. tylko szerokość).
        const picTr = new K.Transformer({
            nodes: [ghost], rotateEnabled: false, keepRatio: true,
            anchorSize: 12, borderEnabled: true,
            borderStroke: '#1a56db', anchorStroke: '#1a56db', anchorFill: '#fff', anchorCornerRadius: 3,
            enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right',
                             'top-center', 'bottom-center', 'middle-left', 'middle-right'],
            boundBoxFunc: (oldB, newB) => (newB.width < 8 || newB.height < 8 ? oldB : newB),
        });
        // Bez ograniczeń pozycji — obraz może być wszędzie (także poza ramką).
        // Kolejność: ghost (przyciemniony, łapie eventy) na dole; inside (wyraźny obraz w ramce, listening:false) nad nim;
        // frame i transformer na samym wierzchu. Dzięki temu w ramce widać czysty obraz, poza ramką — przyciemniony ghost.
        this.ui.add(ghost);
        this.ui.add(inside);
        this.ui.add(frame);
        this.ui.add(picTr);
        this.ui.batchDraw();

        // pomocnik: aktualizuj obraz w klipie ramki (zsynchronizowany z ghostem)
        const syncInside = () => {
            insideImg.setAttrs({
                x: ghost.x(), y: ghost.y(),
                width: ghost.width() * ghost.scaleX(),
                height: ghost.height() * ghost.scaleY(),
            });
        };
        // bieżący stan fit w przestrzeni RAMKI (pt względem el.x, el.y)
        let fitX = ghostX - el.x, fitY = ghostY - el.y, fitW = ghostW, fitH = ghostH;
        const recalcFit = () => {
            fitW = Math.max(2, ghost.width() * ghost.scaleX());
            fitH = Math.max(2, ghost.height() * ghost.scaleY());
            fitX = ghost.x() - el.x;
            fitY = ghost.y() - el.y;
        };

        ghost.on('dragmove', () => { syncInside(); recalcFit(); });
        ghost.on('transform', () => {
            // Gdy keepRatio włączone (domyślnie) — wymuszamy proporcję (defensywnie).
            // Gdy Shift trzymany → keepRatio:false → puszczamy obie osie wolno (możliwe zniekształcenie).
            if (picTr.keepRatio()) {
                const sx = ghost.scaleX();
                ghost.scaleY(sx);
            }
            syncInside(); recalcFit();
        });
        ghost.on('transformend', () => {
            const w = ghost.width() * ghost.scaleX();
            const h = ghost.height() * ghost.scaleY();
            ghost.scaleX(1); ghost.scaleY(1); ghost.width(w); ghost.height(h);
            syncInside(); recalcFit();
            picTr.forceUpdate();
        });

        // Klik na canvasie poza ramką lub poza ghostem → zatwierdź i wyjdź.
        const exitOnOutside = (e) => {
            const tgt = e.target;
            // klikało w ghost lub jego transformer / w ramkę → nie wychodź
            if (tgt === ghost || (tgt && tgt.getParent && tgt.getParent() === picTr)) { return; }
            // klik w sam ghost w środku — też zostaje
            this.exitPictureBox(true);
        };
        this.stage.on('click.picbox tap.picbox', exitOnOutside);

        // Escape / Enter zatwierdzają (dla spójności z innymi trybami).
        // SHIFT = przełącz keepRatio (proporcjonalny → wolny). Trzymaj Shift przy ciągnięciu uchwytu.
        const updateStatus = (shiftDown) => {
            if (!this.hasStatusTarget) { return; }
            this.statusTarget.textContent = shiftDown
                ? '✥ Picture-box [SHIFT]: WOLNE skalowanie (możliwe zniekształcenie) · puść Shift = proporcjonalnie · Esc = gotowe'
                : '↔ Picture-box: przeciągnij = przesuń · uchwyty = zoom proporcjonalny · TRZYMAJ SHIFT = wolne skalowanie (zniekształcenie) · Esc = gotowe';
        };
        const setShift = (down) => {
            if (!this._picBox) { return; }
            picTr.keepRatio(!down);
            updateStatus(down);
            this.ui.batchDraw();
        };
        const keyHandler = (ev) => {
            if (ev.key === 'Escape' || ev.key === 'Enter') {
                ev.preventDefault(); ev.stopPropagation();
                this.exitPictureBox(true);
                return;
            }
            if (ev.key === 'Shift') { setShift(true); }
        };
        const keyUpHandler = (ev) => {
            if (ev.key === 'Shift') { setShift(false); }
        };
        window.addEventListener('keydown', keyHandler, true);
        window.addEventListener('keyup', keyUpHandler, true);

        // Stan
        this._picBox = {
            el, node, ghost, inside, frame, picTr,
            keyHandler, keyUpHandler,
            getFit: () => ({ x: fitX, y: fitY, width: fitW, height: fitH }),
        };
        updateStatus(false);
    }

    /** Zamyka tryb picture-box, zapisuje crop do el.crop (lub usuwa gdy zerowy / pełny obraz). */
    exitPictureBox(save) {
        const s = this._picBox;
        if (!s) { return; }
        const { el, ghost, inside, frame, picTr, keyHandler, keyUpHandler, getFit } = s;
        if (save) {
            const { x, y, width, height } = getFit();
            const W = el.width || 0, H = el.height || 0;
            // Jeśli obraz dokładnie wypełnia ramkę (stretch) — usuń fit/crop (legacy behavior).
            if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5
                && Math.abs(width - W) < 0.5 && Math.abs(height - H) < 0.5) {
                delete el.fit; delete el.crop;
            } else {
                el.fit = {
                    x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
                    width: Math.round(width * 10) / 10, height: Math.round(height * 10) / 10,
                };
                delete el.crop; // od teraz fit jest źródłem prawdy
            }
            this.markDirty();
        }
        // Sprzątanie
        this.stage.off('click.picbox tap.picbox');
        window.removeEventListener('keydown', keyHandler, true);
        if (keyUpHandler) { window.removeEventListener('keyup', keyUpHandler, true); }
        try { picTr.destroy(); } catch (_) {}
        try { ghost.destroy(); } catch (_) {}
        try { inside.destroy(); } catch (_) {}
        try { frame.destroy(); } catch (_) {}
        this.ui.batchDraw();
        this._picBox = null;
        this.renderPage();
        this.select(el.id);
        if (this.hasStatusTarget) { this.statusTarget.textContent = 'Gotowe.'; }
    }

    // ─── Rysowanie własnego kształtu ramki obrazu ──────────
    //   Pen-tool: klik = wierzchołek, dwuklik / Enter = zamknij, Esc = anuluj.
    //   Punkty zapisywane są ZNORMALIZOWANE do bbox [0..1]×[0..1] — przeżyją resize ramki.

    /** Wchodzi w tryb rysowania nowego kształtu dla wskazanego obrazu. */
    startCustomShapeDrawing(el) {
        if (!el || el.type !== 'image') { return; }
        if (this._picBox) { this.exitPictureBox(true); }
        if (this._customDraw) { this._cancelCustomDraw(); }

        const K = this.Konva;
        this._customDraw = {
            el,
            prevShape: el.frameShape || 'rect',
            prevPath:  Array.isArray(el.customPath) ? el.customPath.slice() : null,
            points: [], // punkty W UKŁADZIE STRONY (pt, NIE mnożone przez zoom)
        };

        // Wyłącz zwykłą selekcję i kursora
        this.tr.nodes([]);
        this.layer.draw();
        this.ui.draw();

        // Wstępne narzędzia rysowania
        this._customDrawShape = new K.Line({
            points: [], stroke: '#1a56db', strokeWidth: 1.5, dash: [6, 4],
            closed: false, listening: false, fill: 'rgba(26,86,219,0.06)',
        });
        this.ui.add(this._customDrawShape);
        this._customDrawDots = new K.Group({ listening: false });
        this.ui.add(this._customDrawDots);
        this._customDrawCursor = new K.Line({
            points: [], stroke: '#1a56db', strokeWidth: 1, dash: [3, 3], listening: false,
        });
        this.ui.add(this._customDrawCursor);

        // Obsługa zdarzeń
        this.stage.on('click.cdraw tap.cdraw', (e) => this._onCustomDrawClick(e));
        this.stage.on('dblclick.cdraw dbltap.cdraw', () => this._finishCustomDraw());
        this.stage.on('mousemove.cdraw', () => this._updateCustomDrawCursor());
        this._customDrawKeyHandler = (ev) => {
            if (ev.key === 'Escape') { ev.preventDefault(); this._cancelCustomDraw(); }
            else if (ev.key === 'Enter') { ev.preventDefault(); this._finishCustomDraw(); }
            else if ((ev.key === 'Backspace' || ev.key === 'z' && (ev.ctrlKey || ev.metaKey))) {
                ev.preventDefault();
                if (this._customDraw && this._customDraw.points.length > 0) {
                    this._customDraw.points.pop();
                    this._updateCustomDrawPreview();
                }
            }
        };
        window.addEventListener('keydown', this._customDrawKeyHandler, true);

        // Status bar + zmień kursor
        if (this.hasStatusTarget) {
            this.statusTarget.textContent = '✏️ Rysowanie kształtu: klikaj punkty (min 3). Dwuklik / Enter = zakończ · Backspace = cofnij ostatni · Esc = anuluj.';
        }
        this.stage.container().style.cursor = 'crosshair';
        this.ui.draw();
    }

    _stageToPagePt() {
        const pos = this.stage.getPointerPosition();
        if (!pos) { return null; }
        return { x: pos.x / this.zoom, y: pos.y / this.zoom };
    }

    _onCustomDrawClick() {
        const cd = this._customDraw;
        if (!cd) { return; }
        const pt = this._stageToPagePt();
        if (!pt) { return; }
        // Pomiń kliknięcie blisko ostatniego punktu (debounce dwukliku — pierwszy klik dwukliku już dodał punkt)
        const last = cd.points[cd.points.length - 1];
        if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 3 / this.zoom) { return; }
        cd.points.push(pt);
        this._updateCustomDrawPreview();
    }

    _updateCustomDrawCursor() {
        const cd = this._customDraw;
        if (!cd || !cd.points.length) { if (this._customDrawCursor) { this._customDrawCursor.points([]); this.ui.batchDraw(); } return; }
        const pt = this._stageToPagePt();
        if (!pt) { return; }
        const last = cd.points[cd.points.length - 1];
        // UWAGA: stage ma scale=zoom — pozycje węzłów są w STAGE-UNIT (= page pt). NIE mnożymy przez zoom.
        this._customDrawCursor.points([last.x, last.y, pt.x, pt.y]);
        this.ui.batchDraw();
    }

    _updateCustomDrawPreview() {
        const cd = this._customDraw;
        if (!cd) { return; }
        const flat = [];
        // Punkty w STAGE-UNIT (page pt) — Konva mnoży przez stage.scale automatycznie.
        for (const p of cd.points) { flat.push(p.x, p.y); }
        this._customDrawShape.points(flat);
        this._customDrawShape.closed(cd.points.length >= 3);
        this._customDrawDots.destroyChildren();
        const K = this.Konva;
        for (let i = 0; i < cd.points.length; i++) {
            const p = cd.points[i];
            this._customDrawDots.add(new K.Circle({
                x: p.x, y: p.y, radius: 5 / this.zoom,
                fill: i === 0 ? '#22c55e' : '#fff', stroke: '#1a56db', strokeWidth: 2 / this.zoom,
                listening: false,
            }));
        }
        this.ui.batchDraw();
    }

    _finishCustomDraw() {
        const cd = this._customDraw;
        if (!cd) { return; }
        if (cd.points.length < 3) {
            if (this.hasStatusTarget) { this.statusTarget.textContent = '✏️ Za mało punktów (min 3). Klikaj dalej lub Esc.'; }
            return;
        }
        // Bbox + normalizacja
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of cd.points) {
            if (p.x < x0) { x0 = p.x; } if (p.y < y0) { y0 = p.y; }
            if (p.x > x1) { x1 = p.x; } if (p.y > y1) { y1 = p.y; }
        }
        const w = Math.max(20, x1 - x0), h = Math.max(20, y1 - y0);
        const normalized = cd.points.map((p) => [(p.x - x0) / w, (p.y - y0) / h]);

        // Aktualizujemy element: pozycja+rozmiar = bbox, kształt = custom, path = znormalizowany.
        const el = cd.el;
        el.x = Math.round(x0);
        el.y = Math.round(y0);
        el.width = Math.round(w);
        el.height = Math.round(h);
        el.frameShape = 'custom';
        el.customPath = normalized;
        // Reset kadru — przy zmianie ramki dramatycznie, lepiej żeby obraz wypełnił nowy bbox domyślnie.
        delete el.fit;
        delete el.crop;

        this._cleanupCustomDraw();
        this.markDirty();
        this.renderPage();
        this.select(el.id);
        if (this.hasStatusTarget) { this.statusTarget.textContent = '✓ Kształt utworzony (' + normalized.length + ' punktów). Dwuklik = picture-box.'; }
    }

    _cancelCustomDraw() {
        const cd = this._customDraw;
        if (!cd) { return; }
        // Przywróć wcześniejszy kształt + path
        cd.el.frameShape = cd.prevShape;
        if (cd.prevPath) { cd.el.customPath = cd.prevPath; } else { delete cd.el.customPath; }
        this._cleanupCustomDraw();
        this.syncProps();
        this.renderPage();
        if (this.hasStatusTarget) { this.statusTarget.textContent = '✕ Anulowano rysowanie kształtu.'; }
    }

    _cleanupCustomDraw() {
        if (this._customDrawShape)  { try { this._customDrawShape.destroy();  } catch (_) {} this._customDrawShape  = null; }
        if (this._customDrawDots)   { try { this._customDrawDots.destroy();   } catch (_) {} this._customDrawDots   = null; }
        if (this._customDrawCursor) { try { this._customDrawCursor.destroy(); } catch (_) {} this._customDrawCursor = null; }
        this.stage.off('.cdraw');
        if (this._customDrawKeyHandler) {
            window.removeEventListener('keydown', this._customDrawKeyHandler, true);
            this._customDrawKeyHandler = null;
        }
        this._customDraw = null;
        this.stage.container().style.cursor = '';
        this.ui.batchDraw();
    }

    /** Akcja Stimulus: „Narysuj kształt" w panelu — uruchamia tryb dla aktualnie zaznaczonego obrazu. */
    redrawCustomShape() {
        const el = this.selectedEl();
        if (!el || el.type !== 'image') {
            if (this.hasStatusTarget) { this.statusTarget.textContent = 'Najpierw zaznacz obraz.'; }
            return;
        }
        this.startCustomShapeDrawing(el);
    }

    // ─── Edycja punktów własnego kształtu ──────────────────────────
    //   Przeciągasz handle = przesuwasz wierzchołek (z clampem do bbox ramki).
    //   Alt+klik na linii konturu = wstawia punkt w klikniętej pozycji (na NAJBLIŻSZEJ krawędzi).
    //   Prawy klik / Del/Backspace na aktywnym handle = usuwa punkt (min 3 punkty).
    //   Enter / klik poza = zatwierdź; Esc = cofnij do stanu sprzed wejścia.

    /** Akcja Stimulus: „Edytuj punkty" w panelu. */
    editCustomPoints() {
        const el = this.selectedEl();
        if (!el || el.type !== 'image' || el.frameShape !== 'custom') {
            if (this.hasStatusTarget) { this.statusTarget.textContent = 'Najpierw zaznacz obraz z własnym kształtem.'; }
            return;
        }
        this.startEditCustomPoints(el);
    }

    startEditCustomPoints(el) {
        if (!el || el.type !== 'image') { return; }
        if (!Array.isArray(el.customPath) || el.customPath.length < 3) {
            if (this.hasStatusTarget) { this.statusTarget.textContent = 'Brak kształtu do edycji — najpierw narysuj.'; }
            return;
        }
        if (this._customDraw) { this._cancelCustomDraw(); }
        if (this._customEdit) { this._exitEditCustomPoints(true); }

        this.tr.nodes([]);
        this._customEdit = {
            el,
            prevPath: el.customPath.map((p) => [p[0], p[1]]),
            handles: [],
            outline: null,
            activeIdx: null,
        };
        this._buildEditOutline();
        this._buildEditHandles();

        // Klawiatura
        this._customEditKeyHandler = (ev) => {
            if (!this._customEdit) { return; }
            if (ev.key === 'Escape') { ev.preventDefault(); this._exitEditCustomPoints(false); }
            else if (ev.key === 'Enter') { ev.preventDefault(); this._exitEditCustomPoints(true); }
            else if (ev.key === 'Delete' || (ev.key === 'Backspace' && this._customEdit.activeIdx != null)) {
                ev.preventDefault();
                if (this._customEdit.activeIdx != null) { this._removeEditPoint(this._customEdit.activeIdx); }
            }
        };
        window.addEventListener('keydown', this._customEditKeyHandler, true);

        // Klik poza handle/outline = zatwierdź i wyjdź.
        this.stage.on('click.cedit tap.cedit', (e) => {
            const ce = this._customEdit;
            if (!ce) { return; }
            const t = e.target;
            const inEdit = t && (t === ce.outline || ce.handles.includes(t));
            if (!inEdit) { this._exitEditCustomPoints(true); }
        });

        if (this.hasStatusTarget) {
            this.statusTarget.textContent = '✏️ Edycja punktów: przeciągnij wierzchołek · Alt+klik na linii = wstaw punkt · Del / prawy klik = usuń · Enter/klik poza = OK · Esc = cofnij.';
        }
        this.stage.container().style.cursor = 'default';
        this.ui.draw();
    }

    _buildEditOutline() {
        const K = this.Konva;
        const ce = this._customEdit;
        if (!ce) { return; }
        if (ce.outline) { try { ce.outline.destroy(); } catch (_) {} }
        const el = ce.el;
        const flat = [];
        // Stage-unit (page pt) — Konva mnoży przez stage.scale.
        for (const p of el.customPath) {
            flat.push(el.x + p[0] * el.width, el.y + p[1] * el.height);
        }
        ce.outline = new K.Line({
            points: flat,
            stroke: '#1a56db', strokeWidth: 1.5 / this.zoom, dash: [6 / this.zoom, 4 / this.zoom],
            closed: true, fill: 'rgba(26,86,219,0.04)',
            hitStrokeWidth: 14 / this.zoom,
        });
        // Alt+klik na linii = wstaw punkt na NAJBLIŻSZEJ krawędzi (rzut na odcinek).
        ce.outline.on('click tap', (e) => {
            if (!e.evt || !e.evt.altKey) { return; }
            e.cancelBubble = true;
            this._insertPointAtClick();
        });
        ce.outline.on('mouseenter', () => {
            this.stage.container().style.cursor = ((window.event && window.event.altKey)) ? 'copy' : 'default';
        });
        ce.outline.on('mouseleave', () => { this.stage.container().style.cursor = 'default'; });
        this.ui.add(ce.outline);
        this.ui.batchDraw();
    }

    _buildEditHandles() {
        const K = this.Konva;
        const ce = this._customEdit;
        if (!ce) { return; }
        for (const h of ce.handles) { try { h.destroy(); } catch (_) {} }
        ce.handles = [];
        const el = ce.el;
        const z = this.zoom;
        const R = 6 / z, SW = 2 / z; // rozmiar handle w STAGE-UNIT → stała wielkość na ekranie niezależnie od zoomu
        for (let i = 0; i < el.customPath.length; i++) {
            const p = el.customPath[i];
            const handle = new K.Circle({
                // Stage-unit (page pt): el.x, el.y, el.width, el.height to już są pt; bez mnożenia przez zoom.
                x: el.x + p[0] * el.width,
                y: el.y + p[1] * el.height,
                radius: R,
                fill: i === 0 ? '#22c55e' : '#fff',
                stroke: '#1a56db', strokeWidth: SW,
                draggable: true,
                // dragBoundFunc otrzymuje pozycję ABSOLUTE (w SCREEN-PX). Klamrujemy bbox ramki przemnożony przez zoom.
                dragBoundFunc: (pos) => {
                    const minX = el.x * z, minY = el.y * z;
                    const maxX = (el.x + el.width) * z, maxY = (el.y + el.height) * z;
                    return { x: Math.max(minX, Math.min(maxX, pos.x)), y: Math.max(minY, Math.min(maxY, pos.y)) };
                },
            });
            handle._idx = i;
            handle.on('dragmove', () => this._onHandleDragMove(handle));
            handle.on('dragend',  () => this._onHandleDragEnd(handle));
            handle.on('mouseenter', () => {
                ce.activeIdx = handle._idx;
                handle.fill('#a78bfa'); handle.radius(7 / this.zoom); this.ui.batchDraw();
                this.stage.container().style.cursor = 'move';
            });
            handle.on('mouseleave', () => {
                handle.fill(handle._idx === 0 ? '#22c55e' : '#fff'); handle.radius(6 / this.zoom); this.ui.batchDraw();
                this.stage.container().style.cursor = 'default';
            });
            handle.on('contextmenu', (e) => {
                e.evt.preventDefault();
                this._removeEditPoint(handle._idx);
            });
            ce.handles.push(handle);
            this.ui.add(handle);
        }
        this.ui.batchDraw();
    }

    _onHandleDragMove(handle) {
        const ce = this._customEdit;
        if (!ce) { return; }
        const el = ce.el;
        // handle.x()/.y() zwracają STAGE-UNIT (page pt) — TO SAMO co el.x/y. Bez dzielenia przez zoom.
        const px = handle.x();
        const py = handle.y();
        const nx = (px - el.x) / Math.max(1, el.width);
        const ny = (py - el.y) / Math.max(1, el.height);
        el.customPath[handle._idx] = [Math.max(0, Math.min(1, nx)), Math.max(0, Math.min(1, ny))];
        // Aktualizuj kontur na żywo (też stage-unit).
        if (ce.outline) {
            const flat = [];
            for (const p of el.customPath) {
                flat.push(el.x + p[0] * el.width, el.y + p[1] * el.height);
            }
            ce.outline.points(flat);
        }
        // Konva clipFunc obrazu czyta z el.customPath przez closure → batchDraw ponownie wywołuje clipFunc.
        this.layer.batchDraw();
        this.ui.batchDraw();
    }

    _onHandleDragEnd(_handle) {
        this.markDirty();
    }

    _insertPointAtClick() {
        const ce = this._customEdit;
        if (!ce) { return; }
        const el = ce.el;
        const pos = this._stageToPagePt();
        if (!pos) { return; }
        const nx = Math.max(0, Math.min(1, (pos.x - el.x) / Math.max(1, el.width)));
        const ny = Math.max(0, Math.min(1, (pos.y - el.y) / Math.max(1, el.height)));
        // Znajdź najbliższy odcinek + rzut punktu na ten odcinek.
        let bestIdx = 0, bestDist = Infinity, bestProj = [nx, ny];
        const n = el.customPath.length;
        for (let i = 0; i < n; i++) {
            const a = el.customPath[i];
            const b = el.customPath[(i + 1) % n];
            const [d, proj] = gzPointToSegment(nx, ny, a[0], a[1], b[0], b[1]);
            if (d < bestDist) { bestDist = d; bestIdx = i; bestProj = proj; }
        }
        // Wstaw rzut po bestIdx
        el.customPath.splice(bestIdx + 1, 0, bestProj);
        this._buildEditOutline();
        this._buildEditHandles();
        this.layer.batchDraw();
        this.markDirty();
        if (this.hasStatusTarget) { this.statusTarget.textContent = '+ Wstawiono punkt (Alt+klik). ' + el.customPath.length + ' wierzchołków.'; }
    }

    _removeEditPoint(idx) {
        const ce = this._customEdit;
        if (!ce) { return; }
        if (ce.el.customPath.length <= 3) {
            if (this.hasStatusTarget) { this.statusTarget.textContent = 'Nie można usunąć — kształt musi mieć min 3 punkty.'; }
            return;
        }
        ce.el.customPath.splice(idx, 1);
        ce.activeIdx = null;
        this._buildEditOutline();
        this._buildEditHandles();
        this.layer.batchDraw();
        this.markDirty();
        if (this.hasStatusTarget) { this.statusTarget.textContent = '− Usunięto punkt. Pozostało ' + ce.el.customPath.length + '.'; }
    }

    _exitEditCustomPoints(commit) {
        const ce = this._customEdit;
        if (!ce) { return; }
        if (!commit) { ce.el.customPath = ce.prevPath; }
        if (ce.outline) { try { ce.outline.destroy(); } catch (_) {} }
        for (const h of ce.handles) { try { h.destroy(); } catch (_) {} }
        this.stage.off('.cedit');
        if (this._customEditKeyHandler) {
            window.removeEventListener('keydown', this._customEditKeyHandler, true);
            this._customEditKeyHandler = null;
        }
        const elId = ce.el.id;
        this._customEdit = null;
        this.stage.container().style.cursor = '';
        this.renderPage();
        this.select(elId);
        if (this.hasStatusTarget) {
            this.statusTarget.textContent = commit ? '✓ Zapisano zmiany kształtu.' : '✕ Cofnięto edycję.';
        }
    }

    /** Quark-style: dwuklik na obraz otwiera modal kadrowania. */
    openCropForElement(el) {
        if (this._picBox) { this.exitPictureBox(true); }
        if (!el || el.type !== 'image' || !el.src) { return; }
        this.select(el.id);
        const modalEl = document.getElementById('gzCropModal');
        if (!modalEl) { return; }
        if (window.bootstrap && window.bootstrap.Modal) {
            const inst = window.bootstrap.Modal.getOrCreateInstance(modalEl);
            inst.show();
        } else {
            // fallback: kliknij przycisk uruchamiający modal w panelu właściwości
            const trigger = document.querySelector('[data-bs-target="#gzCropModal"]');
            if (trigger) { trigger.click(); }
        }
    }

    /** Wyrównuje wybrany kadr do proporcji ramki (frame ratio) — przesuwa/skaluje by zachować dokumentowy ratio. */
    cropMatchFrame() {
        const c = this._crop;
        if (!c) { return; }
        const fr = (c.el.width || 1) / (c.el.height || 1);
        // dopasuj wysokość kadru do szerokości
        let cw = c.cw, ch = cw / fr;
        if (ch > c.natH) { ch = c.natH; cw = ch * fr; }
        c.cw = cw; c.ch = ch;
        c.cx = Math.min(c.cx, c.natW - cw);
        c.cy = Math.min(c.cy, c.natH - ch);
        this.placeCropNode(); c.tr.forceUpdate(); c.layer.batchDraw();
    }

    /** „Wypełnij ramkę" (cover): kadr = największy prostokąt o proporcji ramki mieszczący się w obrazie, wycentrowany. */
    cropFitCover() {
        const c = this._crop;
        if (!c) { return; }
        const fr = (c.el.width || 1) / (c.el.height || 1);
        const imgR = c.natW / c.natH;
        let cw, ch;
        if (imgR > fr) { ch = c.natH; cw = ch * fr; } else { cw = c.natW; ch = cw / fr; }
        c.cw = cw; c.ch = ch;
        c.cx = (c.natW - cw) / 2; c.cy = (c.natH - ch) / 2;
        this.placeCropNode(); c.tr.forceUpdate(); c.layer.batchDraw();
    }

    /** „Wpasuj cały obraz" (contain): kadr = cały obraz; ramka dostosuje się do jego proporcji po Zastosuj. */
    cropFitContain() {
        const c = this._crop;
        if (!c) { return; }
        c.cx = 0; c.cy = 0; c.cw = c.natW; c.ch = c.natH;
        this.placeCropNode(); c.tr.forceUpdate(); c.layer.batchDraw();
    }

    applyCrop() {
        const c = this._crop;
        if (!c) return;
        const cw = Math.max(1, Math.round(c.cw)), ch = Math.max(1, Math.round(c.ch));
        c.el.crop = { x: Math.round(c.cx), y: Math.round(c.cy), width: cw, height: ch };
        // Domyślnie ramka przyjmuje proporcje wybranego fragmentu (bez zniekształceń); szerokość zostaje.
        if (!this._cropKeepRatio) {
            c.el.height = Math.max(12, Math.round(c.el.width * ch / cw));
        }
        this.markDirty();
        this.renderPage();
        this.select(c.el.id);
        const btn = document.querySelector('#gzCropModal [data-bs-dismiss="modal"]');
        if (btn) btn.click();
    }

    resetCrop() {
        const el = this.selectedEl();
        if (!el || el.type !== 'image') return;
        delete el.crop;
        delete el.fit;
        this.markDirty();
        this.renderPage();
        this.select(el.id);
    }

    // ─── Ikony (Tabler Icons — open source, wektorowe) ──────

    pickIcon(e) { this.insertIcon(e.params.icon); }

    normalizeIconName(v) {
        return (v || '').trim().replace(/^ti\s+ti-|^ti-/i, '').replace(/\s+/g, '-').toLowerCase();
    }

    iconStatus(msg, err) {
        const el = this.element.querySelector('[data-icon="status"]');
        if (el) { el.textContent = msg; el.className = 'small mb-2 ' + (err ? 'text-danger' : 'text-secondary'); }
    }

    /** Wczytuje pełną listę nazw ikon z CSS webfonta Tablera (raz, cache). */
    async loadIconList() {
        if (this._iconNames) { this.renderIconGrid(); return; }
        this.iconStatus('Wczytuję listę ikon…');
        try {
            const res = await fetch('https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.31.0/dist/tabler-icons.min.css');
            const css = await res.text();
            const set = new Set();
            for (const m of css.matchAll(/\.ti-([a-z0-9-]+):before/g)) set.add(m[1]);
            this._iconNames = [...set].sort();
            this.renderIconGrid();
        } catch (e) {
            this.iconStatus('Nie udało się wczytać listy ikon: ' + e.message, true);
        }
    }

    filterIcons() { this.renderIconGrid(); }

    renderIconGrid() {
        const grid = this.element.querySelector('[data-icon="grid"]');
        if (!grid || !this._iconNames) return;
        const filterInp = this.element.querySelector('[data-icon="filter"]');
        const f = this.normalizeIconName(filterInp && filterInp.value);
        const cap = 600;
        const matches = f ? this._iconNames.filter((n) => n.includes(f)) : this._iconNames;
        const shown = matches.slice(0, cap);

        const frag = document.createDocumentFragment();
        for (const name of shown) {
            const col = document.createElement('div');
            col.className = 'col';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-outline-secondary w-100 p-2';
            btn.title = name;
            const i = document.createElement('i');
            i.className = 'ti ti-' + name;
            i.style.fontSize = '1.3rem';
            btn.appendChild(i);
            btn.addEventListener('click', () => this.insertIcon(name));
            col.appendChild(btn);
            frag.appendChild(col);
        }
        grid.innerHTML = '';
        grid.appendChild(frag);

        this.iconStatus(matches.length + ' ikon' + (matches.length > cap ? ' (pokazano ' + cap + ' — zawęź) ' : '') + ' — kliknij, by wstawić.');
    }

    async fetchIconSvg(dir, file) {
        try {
            const res = await fetch('https://cdn.jsdelivr.net/npm/@tabler/icons@3.31.0/icons/' + dir + '/' + file + '.svg');
            if (!res.ok) return null;
            const t = await res.text();
            return /<svg/i.test(t) ? t : null;
        } catch {
            return null;
        }
    }

    async insertIcon(name) {
        name = this.normalizeIconName(name);
        if (!name) return;
        const color = (this.element.querySelector('[data-icon="color"]') || {}).value || '#1a2330';
        this.iconStatus('Wstawianie ikony…');
        try {
            // Ikony „-filled" są w katalogu filled (bez sufiksu), pozostałe w outline.
            let dir = 'outline', file = name;
            if (name.endsWith('-filled')) { dir = 'filled'; file = name.replace(/-filled$/, ''); }
            let svg = await this.fetchIconSvg(dir, file);
            if (!svg) svg = await this.fetchIconSvg(dir === 'outline' ? 'filled' : 'outline', file);
            if (!svg) throw new Error('Nie znaleziono ikony „' + name + '".');

            const size = 64;
            const el = {
                id: uid(), type: 'icon', x: round((this.pageW - size) / 2), y: 80,
                width: size, height: size, rotation: 0, opacity: 1,
                iconName: name, iconSvg: svg,
                iconColor: color, iconFilled: false, iconFill: color,
                wrapText: false, wrapGap: 9,
            };
            this.regenIconSrc(el);
            this.addElement(el);
            const btn = document.querySelector('#gzIconModal [data-bs-dismiss="modal"]');
            if (btn) btn.click();
        } catch (e) {
            this.iconStatus('Błąd: ' + e.message, true);
        }
    }

    /** Regeneruje data URI ikony z surowego SVG i wybranych kolorów (kreska + opcjonalne wypełnienie). */
    regenIconSrc(el) {
        if (!el.iconSvg) return;
        let s = el.iconSvg.replace(/currentColor/g, el.iconColor || '#1a2330');
        if (el.iconFilled && el.iconFill) {
            s = s.replace(/fill="none"/i, 'fill="' + el.iconFill + '"');
        }
        el.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
    }

    // ─── Znaki specjalne (kropki, kwadraciki, strzałki… w kolorach) ───

    renderCharGrid() {
        const grid = this.element.querySelector('[data-chars="grid"]');
        if (!grid || grid.dataset.built === '1') return;
        const frag = document.createDocumentFragment();
        for (const g of SPECIAL_CHARS) {
            const cap = document.createElement('div');
            cap.className = 'col-12 fw-bold text-secondary small mt-1';
            cap.textContent = g.group;
            frag.appendChild(cap);
            for (const ch of g.chars) {
                const col = document.createElement('div');
                col.className = 'col';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn btn-outline-secondary w-100 p-1';
                btn.style.fontSize = '1.3rem';
                btn.style.lineHeight = '1.4';
                btn.textContent = ch;
                btn.addEventListener('click', () => this.insertChar(ch));
                col.appendChild(btn);
                frag.appendChild(col);
            }
        }
        grid.appendChild(frag);
        grid.dataset.built = '1';
    }

    /** Wstawia znak jako element tekstowy w wybranym kolorze i rozmiarze. */
    insertChar(ch) {
        const colorEl = this.element.querySelector('[data-chars="color"]');
        const sizeEl = this.element.querySelector('[data-chars="size"]');
        const fill = (colorEl && colorEl.value) || '#1a2330';
        const size = clamp(parseInt(sizeEl && sizeEl.value, 10) || 40, 6, 400);
        const w = Math.max(16, Math.round(size * 1.6));
        const h = Math.max(16, Math.round(size * 1.5));
        this.addElement({
            id: uid(), type: 'text',
            x: round((this.pageW - w) / 2), y: 80, width: w, height: h, rotation: 0, opacity: 1,
            text: ch, fontSize: size, fontFamily: 'DejaVu Sans', fontStyle: 'normal',
            fill, align: 'center', valign: 'middle', lineHeight: 1.1, columns: 1, columnGap: 14,
        });
        const cb = document.querySelector('#gzCharsModal [data-bs-dismiss="modal"]');
        if (cb) cb.click();
    }

    // ─── Grafiki (Pixabay) ──────────────────────────────────

    setStockStatus(msg, err) {
        const el = this.element.querySelector('[data-stock="status"]');
        if (el) { el.textContent = msg; el.className = 'small mb-2 ' + (err ? 'text-danger' : 'text-secondary'); }
    }

    stockKey(e) { if (e.key === 'Enter') { e.preventDefault(); this.searchStock(); } }

    /** Pokazuje/ukrywa pola filtrów zależnie od źródła (Unsplash ma orientację, Pixabay ma typ). */
    stockSourceChanged() {
        const root = this.element;
        const src = root.querySelector('[data-stock="source"]').value;
        const typeBox = root.querySelector('[data-stock="typeBox"]');
        const orientBox = root.querySelector('[data-stock="orientBox"]');
        if (typeBox) { typeBox.style.display = (src === 'unsplash') ? 'none' : ''; }
        if (orientBox) { orientBox.style.display = (src === 'unsplash') ? '' : 'none'; }
    }

    async searchStock() {
        const root = this.element;
        const q = (root.querySelector('[data-stock="query"]').value || '').trim();
        const srcSel = root.querySelector('[data-stock="source"]');
        const source = srcSel ? srcSel.value : 'pixabay';
        const type = root.querySelector('[data-stock="type"]').value;
        const orientation = root.querySelector('[data-stock="orientation"]')?.value || 'all';
        const results = root.querySelector('[data-stock="results"]');
        if (!q) { this.setStockStatus('Wpisz, czego szukasz.', true); return; }
        this.setStockStatus('Szukam…');
        results.innerHTML = '';
        try {
            const params = new URLSearchParams({ q, source });
            if (source === 'unsplash') { params.set('orientation', orientation); }
            else { params.set('type', type); }
            const res = await fetch(this.stockSearchUrlValue + '?' + params.toString());
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd wyszukiwania.');
            const tr = (data.query && data.query.toLowerCase() !== q.toLowerCase()) ? ' (ang.: „' + data.query + '")' : '';
            if (!data.results.length) { this.setStockStatus('Brak wyników' + tr + ' — spróbuj innego hasła.'); return; }
            this.setStockStatus(data.results.length + ' wyników' + tr + ' — kliknij grafikę, by ją wstawić.');
            for (const r of data.results) {
                if (!r.full) continue;
                const col = document.createElement('div');
                col.className = 'col';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn btn-outline-secondary w-100 p-1';
                btn.title = r.tags || '';
                const img = document.createElement('img');
                img.src = r.preview;
                img.loading = 'lazy';
                img.style.cssText = 'width:100%;height:88px;object-fit:contain;';
                btn.appendChild(img);
                btn.addEventListener('click', () => this.importStock(r.full, btn));
                col.appendChild(btn);
                results.appendChild(col);
            }
        } catch (e) {
            this.setStockStatus('Błąd: ' + e.message, true);
        }
    }

    // ─── Iconify (logotypy + kolorowe cliparts, SVG na przezroczystym tle) ───────

    iconifyKey(e) { if (e.key === 'Enter') { e.preventDefault(); this.searchIconify(); } }

    setIconifyStatus(msg, isError) {
        const el = this.element.querySelector('[data-iconify="status"]');
        if (el) { el.textContent = msg; el.style.color = isError ? '#c2185b' : ''; }
    }

    async searchIconify() {
        const root = this.element;
        const q = (root.querySelector('[data-iconify="query"]').value || '').trim();
        const pack = (root.querySelector('[data-iconify="pack"]').value || '').trim();
        const results = root.querySelector('[data-iconify="results"]');
        if (!q) { this.setIconifyStatus('Wpisz, czego szukasz.', true); return; }
        this.setIconifyStatus('Szukam…');
        results.innerHTML = '';
        try {
            // Iconify search API (open CORS): https://api.iconify.design/search?query=…&prefix=…&limit=64
            const params = new URLSearchParams({ query: q, limit: '64' });
            if (pack) { params.set('prefix', pack); }
            const res = await fetch('https://api.iconify.design/search?' + params.toString());
            if (!res.ok) { throw new Error('Iconify HTTP ' + res.status); }
            const data = await res.json();
            const icons = Array.isArray(data.icons) ? data.icons : [];
            if (!icons.length) { this.setIconifyStatus('Brak wyników. Spróbuj innego hasła lub paczki.'); return; }
            this.setIconifyStatus(icons.length + ' grafik — kliknij, by wstawić.');
            const frag = document.createDocumentFragment();
            for (const fullName of icons) {
                // fullName = "simple-icons:google"
                const col = document.createElement('div');
                col.className = 'col';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn btn-outline-secondary w-100 p-1';
                btn.title = fullName;
                const img = document.createElement('img');
                img.src = 'https://api.iconify.design/' + fullName + '.svg?height=48';
                img.loading = 'lazy';
                img.style.cssText = 'width:100%;height:48px;object-fit:contain;';
                btn.appendChild(img);
                btn.addEventListener('click', () => this.insertIconify(fullName, btn));
                col.appendChild(btn);
                frag.appendChild(col);
            }
            results.innerHTML = '';
            results.appendChild(frag);
        } catch (e) {
            this.setIconifyStatus('Błąd: ' + e.message, true);
        }
    }

    /** Wstawia grafikę Iconify jako element 'image' z SVG data URI (przezroczyste tło, wektor). */
    async insertIconify(fullName, btn) {
        if (btn) { btn.disabled = true; }
        this.setIconifyStatus('Wstawianie grafiki…');
        try {
            // Pobierz SVG (treść, nie tylko URL — by zapisać data URI w gazetce, bez zależności od internetu w PDF).
            const res = await fetch('https://api.iconify.design/' + fullName + '.svg?height=200');
            if (!res.ok) { throw new Error('Iconify HTTP ' + res.status); }
            const svg = await res.text();
            if (!/<svg/i.test(svg)) { throw new Error('Nie pobrano SVG.'); }
            // Spróbuj odczytać szerokość/wysokość ze SVG (dla zachowania proporcji)
            let aspect = 1;
            const m = svg.match(/viewBox="\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)/i);
            if (m) {
                const vw = parseFloat(m[3]), vh = parseFloat(m[4]);
                if (vw > 0 && vh > 0) { aspect = vw / vh; }
            }
            const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            const h = 100;
            const w = Math.round(h * aspect);
            const el = {
                id: uid(), type: 'image',
                x: round((this.pageW - w) / 2), y: 80,
                width: w, height: h, rotation: 0, opacity: 1,
                src: dataUri,
                // Picture-box dla SVG: domyślnie wypełnia ramkę (fit = całe pole).
            };
            this.addElement(el);
            this.setIconifyStatus('Wstawiono — możesz przesuwać i skalować.');
            const closeBtn = document.querySelector('#gzIconifyModal [data-bs-dismiss="modal"]');
            if (closeBtn) { closeBtn.click(); }
        } catch (e) {
            this.setIconifyStatus('Błąd: ' + e.message, true);
        } finally {
            if (btn) { btn.disabled = false; }
        }
    }

    async importStock(url, btn) {
        this.setStockStatus('Wstawianie grafiki…');
        if (btn) btn.disabled = true;
        try {
            const res = await fetch(this.stockImportUrlValue, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ url }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd importu.');

            const maxW = this.pageW * 0.6, maxH = this.pageH * 0.5;
            let w = data.width || 320, h = data.height || 320;
            const ratio = Math.min(maxW / w, maxH / h, 1);
            w = round(w * ratio); h = round(h * ratio);
            this.addElement({
                id: uid(), type: 'image', x: round((this.pageW - w) / 2), y: 80,
                width: w, height: h, rotation: 0, opacity: 1, src: data.url, wrapText: true, wrapGap: 9,
            });
            const cb = document.querySelector('#gzStockModal [data-bs-dismiss="modal"]');
            if (cb) cb.click();
        } catch (e) {
            this.setStockStatus('Błąd: ' + e.message, true);
            if (btn) btn.disabled = false;
        }
    }

    // ─── Magazyn mediów (wgrane / AI / Pixabay — wszystkie własne grafiki) ───

    setMediaStatus(msg, err) {
        const el = this.element.querySelector('[data-media="status"]');
        if (el) { el.textContent = msg; el.className = 'small mb-2 ' + (err ? 'text-danger' : 'text-secondary'); }
    }

    /** Wczytuje listę grafik z magazynu (katalog uploadów użytkownika) i odświeża siatkę. */
    async loadMedia() {
        if (!this._mediaFilter) this._mediaFilter = 'all';
        this.setMediaStatus('Wczytuję magazyn…');
        const grid = this.element.querySelector('[data-media="grid"]');
        if (grid) grid.innerHTML = '';
        try {
            const res = await fetch(this.mediaListUrlValue, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd wczytywania.');
            this._media = data.items || [];
            this.renderMediaGrid();
        } catch (e) {
            this.setMediaStatus('Błąd: ' + e.message, true);
        }
    }

    filterMedia(e) {
        this._mediaFilter = (e.params && e.params.filter) || 'all';
        this.element.querySelectorAll('[data-media-filter]').forEach(
            (b) => b.classList.toggle('active', b.dataset.mediaFilter === this._mediaFilter));
        this.renderMediaGrid();
    }

    renderMediaGrid() {
        const grid = this.element.querySelector('[data-media="grid"]');
        if (!grid || !this._media) return;

        if (!this._media.length) {
            grid.innerHTML = '';
            this.setMediaStatus('Magazyn jest pusty. Wgraj zdjęcie, wygeneruj grafikę AI lub pobierz z Pixabay — wszystko pojawi się tutaj do ponownego użycia.');
            return;
        }

        const f = this._mediaFilter || 'all';
        const items = f === 'all' ? this._media : this._media.filter((it) => it.kind === f);
        this.setMediaStatus(items.length + ' grafik — kliknij, by wstawić na bieżącą stronę. Ikoną kosza usuniesz grafikę z magazynu.');

        const label = { upload: 'Wgrane', ai: 'AI', stock: 'Pixabay' };
        const badgeCls = { upload: 'bg-secondary', ai: 'bg-purple', stock: 'bg-azure' };
        const frag = document.createDocumentFragment();
        for (const it of items) {
            const col = document.createElement('div');
            col.className = 'col';
            const wrap = document.createElement('div');
            wrap.className = 'gz-media-item';

            const ins = document.createElement('button');
            ins.type = 'button';
            ins.className = 'btn btn-outline-secondary w-100 p-1';
            ins.title = it.name + ' · ' + it.width + '×' + it.height + ' px';
            const img = document.createElement('img');
            img.src = it.url;
            img.loading = 'lazy';
            img.className = 'gz-media-thumb';
            ins.appendChild(img);
            ins.addEventListener('click', () => this.insertMedia(it));

            const badge = document.createElement('span');
            badge.className = 'badge gz-media-badge ' + (badgeCls[it.kind] || 'bg-secondary');
            badge.textContent = label[it.kind] || it.kind;

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'btn btn-icon btn-sm btn-danger gz-media-del';
            del.title = 'Usuń z magazynu';
            del.innerHTML = '<i class="ti ti-trash"></i>';
            del.addEventListener('click', (ev) => { ev.stopPropagation(); this.deleteMedia(it, del); });

            wrap.appendChild(ins);
            wrap.appendChild(badge);
            wrap.appendChild(del);
            col.appendChild(wrap);
            frag.appendChild(col);
        }
        grid.innerHTML = '';
        grid.appendChild(frag);
    }

    /** Wstawia grafikę z magazynu na bieżącą stronę (jak upload / Pixabay).
     *  Gdy aktywny `_fillFrameId` → uzupełnia istniejącą RAMKĘ zamiast tworzyć nowy element. */
    insertMedia(it) {
        if (this._fillFrameId && this._fillFrameWithImage(this._fillFrameId, it.url)) {
            // Brute-close — `cb.click()` (data-bs-dismiss) bywał ignorowany po wcześniejszym dispose pickera.
            this._brutalCloseModal('gzMediaModal');
            if (this.hasStatusTarget) { this.statusTarget.textContent = 'Zdjęcie wstawione do ramki.'; }
            return;
        }
        const maxW = this.pageW * 0.6, maxH = this.pageH * 0.5;
        let w = it.width || 320, h = it.height || 320;
        const ratio = Math.min(maxW / w, maxH / h, 1);
        w = round(w * ratio); h = round(h * ratio);
        this.addElement({
            id: uid(), type: 'image', x: round((this.pageW - w) / 2), y: 80,
            width: w, height: h, rotation: 0, opacity: 1, src: it.url, wrapText: true, wrapGap: 9,
        });
        // Zwykły flow — używamy tej samej brute-close metody dla spójności.
        this._brutalCloseModal('gzMediaModal');
    }

    /** Ile razy dana grafika jest użyta w bieżącej gazetce (ostrzeżenie przy usuwaniu). */
    mediaUsageCount(url) {
        let n = 0;
        for (const p of this.doc.pages) {
            for (const el of p.elements) if (el.type === 'image' && el.src === url) n++;
        }
        return n;
    }

    async deleteMedia(it, btn) {
        const used = this.mediaUsageCount(it.url);
        const msg = used > 0
            ? 'Ta grafika jest używana w tej gazetce (' + used + '×). Po usunięciu pliku zniknie ze stron. Usunąć mimo to?'
            : 'Usunąć tę grafikę z magazynu? Tej operacji nie można cofnąć.';
        if (!confirm(msg)) return;
        if (btn) btn.disabled = true;
        try {
            const res = await fetch(this.mediaDeleteUrlValue, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ url: it.url }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd usuwania.');
            this._media = this._media.filter((m) => m.url !== it.url);
            this.renderMediaGrid();
            if (used > 0) { delete this.imageCache[it.url]; this.renderPage(); }
        } catch (e) {
            this.setMediaStatus('Błąd: ' + e.message, true);
            if (btn) btn.disabled = false;
        }
    }

    // ─── Podgląd rozkładówki (2 strony obok siebie) ─────────

    setupSpread() {
        const N = this.doc.pages.length;
        const selL = this.element.querySelector('[data-spread="left"]');
        const selR = this.element.querySelector('[data-spread="right"]');
        if (!selL || !selR) return;

        // Domyślnie: bieżąca strona + następna (a gdy to ostatnia — poprzednia + bieżąca).
        let l = this.current, r = this.current + 1;
        if (r >= N) { r = this.current; l = Math.max(0, this.current - 1); }

        const fill = (sel, val) => {
            sel.innerHTML = '';
            for (let i = 0; i < N; i++) {
                const o = document.createElement('option');
                o.value = String(i);
                o.textContent = 'Strona ' + (i + 1);
                if (i === val) o.selected = true;
                sel.appendChild(o);
            }
        };
        fill(selL, l);
        fill(selR, r);
        this.renderSpread();
    }

    renderSpread() {
        const selL = this.element.querySelector('[data-spread="left"]');
        const selR = this.element.querySelector('[data-spread="right"]');
        const imgL = this.element.querySelector('[data-spread="imgL"]');
        const imgR = this.element.querySelector('[data-spread="imgR"]');
        if (!selL || !imgL) return;
        const last = this.doc.pages.length - 1;
        const li = clamp(parseInt(selL.value, 10) || 0, 0, last);
        const ri = clamp(parseInt(selR.value, 10) || 0, 0, last);
        imgL.src = this.pageToDataURL(li, 1.6);
        imgR.src = this.pageToDataURL(ri, 1.6);
    }

    // ─── Klawiatura ─────────────────────────────────────────

    bindGlobalKeys() {
        this._keyHandler = (e) => {
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
            if (document.querySelector('.modal.show')) return; // nie przechwytuj skrótów przy otwartym oknie

            const hasSel = this.selectedIds.length > 0;
            if ((e.key === 'Delete' || e.key === 'Backspace') && hasSel) {
                e.preventDefault(); this.deleteSelected();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
                e.preventDefault(); if (e.shiftKey) this.ungroupSelected(); else this.groupSelected();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                e.preventDefault(); this.redo();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault(); this.save();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && hasSel) {
                e.preventDefault(); this.duplicateSelected();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && hasSel) {
                e.preventDefault(); this.copySelected();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && hasSel) {
                e.preventDefault(); this.cutSelected();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && this.clipboard) {
                e.preventDefault(); this.pasteClipboard();
            } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
                // Ctrl+0 = dopasuj stronę do widoku (fit)
                e.preventDefault(); this.zoomFit();
            } else if ((e.ctrlKey || e.metaKey) && e.key === '1') {
                // Ctrl+1 = 100% (zoom 1:1)
                e.preventDefault(); this.zoomReset();
            } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
                // Ctrl++ = zoom in (zachowuje środek widoku — wheel ma mouse-centered)
                e.preventDefault(); this.zoomIn();
            } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
                // Ctrl+- = zoom out
                e.preventDefault(); this.zoomOut();
            } else if (hasSel && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
                const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
                for (const id of this.selectedIds) { const el = this.elById(id); if (el) { el.x += dx; el.y += dy; } }
                this.markDirty(); this.renderPage(); this.reattachTransformer();
            }
        };
        window.addEventListener('keydown', this._keyHandler);
    }
}

// ─── Pomocnicze ─────────────────────────────────────────────
function uid() { return 'el_' + Math.random().toString(36).slice(2, 9); }
function round(n) { return Math.round(n); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ─── Eksport PDF (wektor): mapowanie krojów + pomocnicze ──────
// Katalog z osadzanymi krojami TTF (latin-ext). Kroje własnościowe → metrycznie zgodne, wolne odpowiedniki.
const PDF_FONTS_BASE = '/fonts/gazetka';
const PDF_ASCENT = 0.9; // baseline = top + fontSize*PDF_ASCENT (skalibrowane wizualnie)
const PDF_FONT_MAP = {
    'Georgia': 'gelasio', 'Times New Roman': 'tinos',
    'Arial': 'arimo', 'Trebuchet MS': 'arimo', 'Verdana': 'arimo', 'Tahoma': 'arimo',
    'Courier New': 'cousine',
    'Lora': 'lora', 'Merriweather': 'merriweather', 'Playfair Display': 'playfair-display',
    'Roboto': 'roboto', 'Open Sans': 'open-sans', 'Lato': 'lato',
    'Montserrat': 'montserrat', 'Oswald': 'oswald', 'Raleway': 'raleway',
    'Kalam': 'kalam', // odręczny/markerowy (m.in. plakaty) — ma polskie znaki
    'DejaVu Sans': 'dejavu-sans', // krój z szerokim pokryciem symboli (znaki specjalne)
};

/** Nazwa pliku kroju (bez .ttf) dla rodziny+stylu, z fallbackami; null gdy brak w manifeście. */
function pdfFileFor(manifest, family, bold, italic) {
    const id = PDF_FONT_MAP[family] || 'gelasio';
    const w = bold ? '700' : '400';
    const s = italic ? 'i' : '';
    const cands = [`${id}-${w}${s}`, `${id}-${w}`, `${id}-400${s}`, `${id}-400`, 'gelasio-400'];
    return cands.find((c) => manifest.has(c)) || null;
}

/**
 * KSZTAŁTY RAMKI dla obrazów (el.frameShape).
 * Jedna lista komend `[op, ...params]` → adaptujemy do canvas 2D (clipFunc Konva, raster PDF)
 * i do SVG path (eksport / K.Path do cieni).
 * Obsługiwane: rect (z opcjonalnym cornerRadius), circle, ellipse, polygon-N (N=3..12),
 *              star-N (N=4..12), heart, speech (dymek), arrow-right.
 */
function _gzShapeCommands(shape, w, h, el) {
    const cmds = [];
    const M = (x, y) => cmds.push(['M', x, y]);
    const L = (x, y) => cmds.push(['L', x, y]);
    const Q = (cx, cy, x, y) => cmds.push(['Q', cx, cy, x, y]);
    const C = (c1x, c1y, c2x, c2y, x, y) => cmds.push(['C', c1x, c1y, c2x, c2y, x, y]);
    const Z = () => cmds.push(['Z']);

    // Własny kształt — punkty znormalizowane do [0..1] × [0..1] w bbox ramki (rysowane przez użytkownika).
    if (shape === 'custom' && el && Array.isArray(el.customPath) && el.customPath.length >= 3) {
        for (let i = 0; i < el.customPath.length; i++) {
            const p = el.customPath[i];
            if (!Array.isArray(p) || p.length < 2) { continue; }
            const px = p[0] * w, py = p[1] * h;
            if (i === 0) { M(px, py); } else { L(px, py); }
        }
        Z();
        return cmds;
    }

    if (!shape || shape === 'rect' || shape === 'custom') {
        // shape === 'custom' bez customPath → bezpieczny fallback do rect.
        M(0, 0); L(w, 0); L(w, h); L(0, h); Z();
        return cmds;
    }

    if (shape === 'circle' || shape === 'ellipse') {
        const cx = w / 2, cy = h / 2;
        const rx = (shape === 'circle') ? Math.min(w, h) / 2 : w / 2;
        const ry = (shape === 'circle') ? Math.min(w, h) / 2 : h / 2;
        const k = 0.5522847498;
        const kx = rx * k, ky = ry * k;
        M(cx, cy - ry);
        C(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy);
        C(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry);
        C(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy);
        C(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry);
        Z();
        return cmds;
    }

    const polyMatch = String(shape).match(/^polygon-(\d+)$/);
    if (polyMatch) {
        const N = Math.max(3, Math.min(12, parseInt(polyMatch[1], 10)));
        const cx = w / 2, cy = h / 2;
        const rx = w / 2, ry = h / 2;
        for (let i = 0; i < N; i++) {
            const ang = -Math.PI / 2 + 2 * Math.PI * i / N;
            const px = cx + rx * Math.cos(ang);
            const py = cy + ry * Math.sin(ang);
            if (i === 0) { M(px, py); } else { L(px, py); }
        }
        Z();
        return cmds;
    }

    const starMatch = String(shape).match(/^star-(\d+)$/);
    if (starMatch) {
        const N = Math.max(4, Math.min(12, parseInt(starMatch[1], 10)));
        const cx = w / 2, cy = h / 2;
        const minSize = Math.min(w, h);
        const rOut = minSize / 2;
        const rIn = rOut * 0.42;
        const sx = w / minSize, sy = h / minSize;
        for (let i = 0; i < 2 * N; i++) {
            const r = i % 2 === 0 ? rOut : rIn;
            const ang = -Math.PI / 2 + Math.PI * i / N;
            const px = cx + r * Math.cos(ang) * sx;
            const py = cy + r * Math.sin(ang) * sy;
            if (i === 0) { M(px, py); } else { L(px, py); }
        }
        Z();
        return cmds;
    }

    if (shape === 'heart') {
        // Serce skomponowane z dwóch krzywych Béziera — sprawdzone proporcje.
        const X = (u) => u * w, Y = (v) => v * h;
        M(X(0.5), Y(0.95));
        C(X(0.05), Y(0.65), X(-0.05), Y(0.30), X(0.18), Y(0.12));
        C(X(0.32), Y(0.02), X(0.42), Y(0.08), X(0.50), Y(0.25));
        C(X(0.58), Y(0.08), X(0.68), Y(0.02), X(0.82), Y(0.12));
        C(X(1.05), Y(0.30), X(0.95), Y(0.65), X(0.50), Y(0.95));
        Z();
        return cmds;
    }

    if (shape === 'speech') {
        // Dymek dialogu: zaokrąglony prostokąt z ogonkiem u dołu po lewej.
        const r = Math.min(w, h) * 0.12;
        const bodyB = h * 0.70;
        M(r, 0);
        L(w - r, 0);
        Q(w, 0, w, r);
        L(w, bodyB - r);
        Q(w, bodyB, w - r, bodyB);
        L(w * 0.40, bodyB);
        L(w * 0.20, h);
        L(w * 0.32, bodyB);
        L(r, bodyB);
        Q(0, bodyB, 0, bodyB - r);
        L(0, r);
        Q(0, 0, r, 0);
        Z();
        return cmds;
    }

    if (shape === 'arrow-right') {
        const tailY1 = h * 0.25, tailY2 = h * 0.75;
        const headW = w * 0.40;
        M(0, tailY1);
        L(w - headW, tailY1);
        L(w - headW, 0);
        L(w, h / 2);
        L(w - headW, h);
        L(w - headW, tailY2);
        L(0, tailY2);
        Z();
        return cmds;
    }

    // Fallback: prostokąt.
    M(0, 0); L(w, 0); L(w, h); L(0, h); Z();
    return cmds;
}

/** Rysuje ścieżkę kształtu na canvas 2D (do clipFunc Konva / clipu rastra PDF). */
function gzDrawShape(ctx, shape, x, y, w, h, el) {
    const cmds = _gzShapeCommands(shape, w, h, el);
    for (const c of cmds) {
        const op = c[0];
        if (op === 'M') { ctx.moveTo(x + c[1], y + c[2]); }
        else if (op === 'L') { ctx.lineTo(x + c[1], y + c[2]); }
        else if (op === 'Q') { ctx.quadraticCurveTo(x + c[1], y + c[2], x + c[3], y + c[4]); }
        else if (op === 'C') { ctx.bezierCurveTo(x + c[1], y + c[2], x + c[3], y + c[4], x + c[5], y + c[6]); }
        else if (op === 'Z') { ctx.closePath(); }
    }
}

/** Konwertuje listę komend kształtu na listę odcinków liniowych (subdywizja Bézierów).
 *  Zwraca tablicę [[{x,y}, {x,y}], ...] — używane przy obliczaniu silhouette dla oblewania tekstem. */
function _gzShapeToSegments(shape, w, h, el) {
    const cmds = _gzShapeCommands(shape, w, h, el);
    const segs = [];
    let cur = null, start = null;
    const N_BEZ = 8; // liczba subdywizji per krzywa (kompromis dokładność/koszt)
    for (const c of cmds) {
        const op = c[0];
        if (op === 'M') {
            cur = { x: c[1], y: c[2] };
            start = cur;
        } else if (op === 'L') {
            const next = { x: c[1], y: c[2] };
            segs.push([cur, next]);
            cur = next;
        } else if (op === 'Q') {
            const cx = c[1], cy = c[2], ex = c[3], ey = c[4];
            for (let i = 1; i <= N_BEZ; i++) {
                const t = i / N_BEZ, omt = 1 - t;
                const x = omt * omt * cur.x + 2 * omt * t * cx + t * t * ex;
                const y = omt * omt * cur.y + 2 * omt * t * cy + t * t * ey;
                const next = { x, y };
                segs.push([cur, next]);
                cur = next;
            }
        } else if (op === 'C') {
            const c1x = c[1], c1y = c[2], c2x = c[3], c2y = c[4], ex = c[5], ey = c[6];
            for (let i = 1; i <= N_BEZ; i++) {
                const t = i / N_BEZ, omt = 1 - t;
                const omt2 = omt * omt, omt3 = omt2 * omt;
                const t2 = t * t, t3 = t2 * t;
                const x = omt3 * cur.x + 3 * omt2 * t * c1x + 3 * omt * t2 * c2x + t3 * ex;
                const y = omt3 * cur.y + 3 * omt2 * t * c1y + 3 * omt * t2 * c2y + t3 * ey;
                const next = { x, y };
                segs.push([cur, next]);
                cur = next;
            }
        } else if (op === 'Z') {
            if (cur && start) { segs.push([cur, start]); }
        }
    }
    return segs;
}

/** Zwraca x-extent [xMin, xMax] silhouette kształtu w PASIE y ∈ [yTop, yBot] (układ lokalny ramki: 0..w × 0..h).
 *  null oznacza, że pas nie przecina kształtu (tekst może płynąć bez ograniczeń).
 *  Dla okręgu/elipsy używamy formuły analitycznej; dla reszty — skanujemy odcinki. */
function gzShapeExtentInLocalBand(shape, w, h, el, yTop, yBot) {
    yTop = Math.max(0, Math.min(h, yTop));
    yBot = Math.max(0, Math.min(h, yBot));
    if (yBot <= yTop) { return null; }

    // Analityczne dla okręgu i elipsy — szybsze + dokładniejsze.
    if (shape === 'circle' || shape === 'ellipse') {
        const cx = w / 2, cy = h / 2;
        const rx = (shape === 'circle') ? Math.min(w, h) / 2 : w / 2;
        const ry = (shape === 'circle') ? Math.min(w, h) / 2 : h / 2;
        const ys = [yTop, yBot];
        if (yTop <= cy && cy <= yBot) { ys.push(cy); } // równik daje max szerokość
        let xMin = Infinity, xMax = -Infinity;
        for (const y of ys) {
            const t = (y - cy) / ry;
            if (Math.abs(t) > 1) { continue; }
            const dx = rx * Math.sqrt(1 - t * t);
            if (cx - dx < xMin) { xMin = cx - dx; }
            if (cx + dx > xMax) { xMax = cx + dx; }
        }
        if (xMin === Infinity) { return null; }
        return [xMin, xMax];
    }

    // Skan odcinków dla pozostałych (polygon-N, star-N, heart, speech, arrow-right, custom).
    const segs = _gzShapeToSegments(shape, w, h, el);
    if (!segs.length) { return null; }
    const SAMPLE = 5;
    let xMin = Infinity, xMax = -Infinity;
    for (let i = 0; i <= SAMPLE; i++) {
        const y = yTop + (yBot - yTop) * (SAMPLE > 0 ? i / SAMPLE : 0);
        for (const [a, b] of segs) {
            // Przecięcie poziomej linii y=y z odcinkiem a-b
            if ((a.y <= y && b.y >= y) || (b.y <= y && a.y >= y)) {
                if (a.y === b.y) {
                    if (a.x < xMin) { xMin = a.x; } if (a.x > xMax) { xMax = a.x; }
                    if (b.x < xMin) { xMin = b.x; } if (b.x > xMax) { xMax = b.x; }
                } else {
                    const t = (y - a.y) / (b.y - a.y);
                    const x = a.x + t * (b.x - a.x);
                    if (x < xMin) { xMin = x; }
                    if (x > xMax) { xMax = x; }
                }
            }
        }
    }
    if (xMin === Infinity) { return null; }
    return [xMin, xMax];
}

/** Mały PRNG z ziarnem (mulberry32) — deterministyczna pseudo-losowość per element. */
function _gzMulberry32(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/** Hash string → liczba (do ziarna PRNG, deterministycznie per id elementu). */
function _gzStrToSeed(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h || 1;
}

/**
 * Rysuje na ctx ścieżkę kształtu Z PERTURBACJĄ — używane do efektów krawędzi (brush, torn).
 * Subdywiduje każdy odcinek (i krzywą Béziera, którą wcześniej rozkładamy do segmentów),
 * dodaje przesunięcie po NORMALNEJ do segmentu o losową wartość (z stałym ziarnem) → falujące/poszarpane krawędzie.
 *  - style 'brush'  → łagodne, gęsto próbkowane, mniejsza amplituda (malowany wygląd)
 *  - style 'torn'   → ostre, mniej gęste, większa amplituda (rwany papier)
 */
function gzPerturbedShapePath(ctx, shape, x, y, w, h, el, style) {
    const intensityMul = _gzStyleIntensity(el); // mnożnik z slidera (0..2; 1=domyślny)
    const seed = _gzStrToSeed((el && el.id ? String(el.id) : 'x') + ':' + (style || '') + ':' + Math.round(w) + 'x' + Math.round(h) + ':' + Math.round(intensityMul * 100));
    const PRNG = _gzMulberry32(seed);
    const segs = _gzShapeToSegments(shape || 'rect', w, h, el);
    if (!segs.length) { return; }

    const minSize = Math.min(w, h);
    let intensity, stepSize;
    if (style === 'torn') {
        intensity = Math.max(3, minSize * 0.030) * intensityMul;
        stepSize  = Math.max(4, minSize * 0.040);
    } else {
        // brush (domyślnie)
        intensity = Math.max(1.5, minSize * 0.018) * intensityMul;
        stepSize  = Math.max(3, minSize * 0.025);
    }

    const pts = [];
    for (const [a, b] of segs) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 0.1) { continue; }
        const n = Math.max(1, Math.ceil(len / stepSize));
        const nx = -dy / len, ny = dx / len; // wektor normalny do odcinka
        for (let i = 0; i < n; i++) {
            const t = i / n;
            const sx = a.x + dx * t;
            const sy = a.y + dy * t;
            const perturb = (PRNG() * 2 - 1) * intensity;
            pts.push([sx + nx * perturb, sy + ny * perturb]);
        }
    }
    if (pts.length < 3) { return; }
    ctx.moveTo(x + pts[0][0], y + pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(x + pts[i][0], y + pts[i][1]);
    }
    ctx.closePath();
}

/**
 * Mnożnik intensywności efektu (slider 0..100, default 50 = 1.0). Zakres wynikowy: 0..2.
 * Używane przez wszystkie 4 style efektów krawędzi.
 */
function _gzStyleIntensity(el) {
    const v = el && el.frameStyleIntensity;
    if (v == null || !Number.isFinite(v)) { return 1; }
    return Math.max(0, Math.min(2, v / 50));
}

/**
 * Generuje canvas-maskę „grubego pędzla radialnego" — N pociągnięć od środka ramki do krawędzi,
 * z różną długością, kątem (jitter) i szerokością. Używana z composite `destination-in`
 * → obraz widoczny TYLKO pod sumą pociągnięć pędzla = wygląda jakby był malowany.
 * Cache jest CELOWO pomijany — render jest szybki (~2-5 ms) i deterministyczny dzięki ziarnu.
 */
function gzPaintedMaskCanvas(w, h, el) {
    const intensity = _gzStyleIntensity(el); // 0..2
    const seed = _gzStrToSeed((el && el.id ? String(el.id) : 'x') + ':paint:' + Math.round(w) + 'x' + Math.round(h) + ':' + Math.round(intensity * 100));
    const PRNG = _gzMulberry32(seed);
    const cv = document.createElement('canvas');
    const W = Math.max(8, Math.round(w));
    const H = Math.max(8, Math.round(h));
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const cx = W / 2, cy = H / 2;
    const diag = Math.hypot(W, H) / 2; // promień opisanego okręgu
    // Liczba pociągnięć rośnie z intensywnością; szerokość ujmuje pełne pokrycie przy 100%.
    const N = Math.round(60 + intensity * 80);
    const reachBase = 0.55 + intensity * 0.30; // 0.55..1.15× diag
    const widthBase = Math.max(2, Math.min(W, H) * 0.04 * (0.6 + intensity * 0.6));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#000';
    // Mały „filling-blob" w centrum żeby na pewno środek był pokryty (niezależnie od pociągnięć).
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(W, H) * 0.06, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < N; i++) {
        const angle = (i / N) * Math.PI * 2 + (PRNG() - 0.5) * 0.18;
        const reach = reachBase + (PRNG() - 0.5) * 0.45;
        const len = diag * Math.max(0.25, reach);
        const wid = widthBase * (0.6 + PRNG() * 1.0);
        ctx.lineWidth = wid;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
        ctx.stroke();
    }
    return cv;
}

/**
 * Rysuje na ctx ŚCIEŻKĘ obrysu znaczka pocztowego — prostokąt z perforacjami (półokrągłymi wcięciami)
 * wzdłuż wszystkich 4 krawędzi. Liczba perforacji jest adaptacyjna (~16 na dłuższy bok, min 6).
 * NIE wywołuje fill/stroke — sam path do dalszego użycia (clip, fill itd.).
 */
function gzStampOutlinePath(ctx, x, y, w, h) {
    const targetN = 16;
    const sp = Math.min(w, h) / targetN;
    const nx = Math.max(6, Math.round(w / sp));
    const ny = Math.max(6, Math.round(h / sp));
    const dx = w / nx;
    const dy = h / ny;
    const r = Math.min(dx, dy) * 0.42; // promień perforacji

    ctx.moveTo(x, y);
    // Górna krawędź L→R: perforacje wcięte W DÓŁ (w stronę środka znaczka)
    for (let i = 0; i < nx; i++) {
        const cx = x + (i + 0.5) * dx;
        ctx.lineTo(cx - r, y);
        ctx.arc(cx, y, r, Math.PI, 0, true);
    }
    ctx.lineTo(x + w, y);
    // Prawa krawędź T→B: perforacje wcięte W LEWO
    for (let i = 0; i < ny; i++) {
        const cy = y + (i + 0.5) * dy;
        ctx.lineTo(x + w, cy - r);
        ctx.arc(x + w, cy, r, -Math.PI / 2, Math.PI / 2, true);
    }
    ctx.lineTo(x + w, y + h);
    // Dolna krawędź R→L: perforacje wcięte W GÓRĘ
    for (let i = 0; i < nx; i++) {
        const cx = x + w - (i + 0.5) * dx;
        ctx.lineTo(cx + r, y + h);
        ctx.arc(cx, y + h, r, 0, Math.PI, true);
    }
    ctx.lineTo(x, y + h);
    // Lewa krawędź B→T: perforacje wcięte W PRAWO
    for (let i = 0; i < ny; i++) {
        const cy = y + h - (i + 0.5) * dy;
        ctx.lineTo(x, cy + r);
        ctx.arc(x, cy, r, Math.PI / 2, -Math.PI / 2, true);
    }
    ctx.lineTo(x, y);
    ctx.closePath();
}

/**
 * Rysuje na ctx WARSTWY białej ramki znaczka pocztowego (perforacje na zewnątrz, prostokątne wnętrze):
 * outer = perforowany kontur, inner = mniejszy prostokąt → fill evenodd daje biały pierścień.
 * Cienki ciemny zarys na wewnętrznej krawędzi dla głębi.
 */
function gzDrawStampFrameRing(ctx, w, h) {
    const m = Math.min(w, h) * 0.08; // margines białej ramki
    // Biały pierścień
    ctx.beginPath();
    gzStampOutlinePath(ctx, 0, 0, w, h);
    ctx.rect(m, m, w - 2 * m, h - 2 * m);
    ctx.fillStyle = '#ffffff';
    ctx.fill('evenodd');
    // Cienka ciemna kreska na granicy ze zdjęciem (efekt głębi)
    ctx.beginPath();
    ctx.rect(m, m, w - 2 * m, h - 2 * m);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = Math.max(0.5, Math.min(w, h) * 0.002);
    ctx.stroke();
}

/**
 * Rysuje na ctx warstwy złoconej ramy obrazu (kasetowej): 4 pierścienie - outer dark,
 * główne złoto z gradientem chiaroscuro, wewnętrzna ciemna kreska, najbliżej zdjęcia jasny highlight.
 * Wymaga evenodd fill. Cała rama mieści się W BBOX obrazu (zdjęcie jest pod nią; rama zasłania marginesy).
 */
function gzDrawPictureFrameRing(ctx, w, h) {
    const t = Math.max(10, Math.min(w, h) * 0.07); // łączna grubość ramy
    const ring = (outerInset, innerInset, fill) => {
        ctx.beginPath();
        ctx.rect(outerInset, outerInset, w - 2 * outerInset, h - 2 * outerInset);
        ctx.rect(innerInset, innerInset, w - 2 * innerInset, h - 2 * innerInset);
        ctx.fillStyle = fill;
        ctx.fill('evenodd');
    };
    // 1) Cieniutka ciemna obwódka zewnętrzna
    ring(0, t * 0.12, '#241803');
    // 2) Główna złota część z gradientem (chiaroscuro – jasne w lewym-górnym, ciemne w prawym-dolnym)
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0.00, '#8c6b15');
    grad.addColorStop(0.20, '#d6b245');
    grad.addColorStop(0.45, '#f6dc83');
    grad.addColorStop(0.55, '#f6dc83');
    grad.addColorStop(0.80, '#b78c1c');
    grad.addColorStop(1.00, '#5a4310');
    ring(t * 0.12, t * 0.85, grad);
    // 3) Ciemna kreska między złotem a obrazem (jak w cassetta-frame)
    ring(t * 0.85, t * 0.94, '#1a1004');
    // 4) Cieniutki jaśniejszy złoty highlight na najwewnętrzniejszej krawędzi
    ring(t * 0.94, t, '#e3c266');
}

/**
 * Wspólny generator parametrów + punktów dla ramki pędzlowej. PRNG re-inicjalizowany ZIARNEM
 * przy każdym wywołaniu → IDENTYCZNE punkty za każdym razem (clipFunc + overlay muszą się zgadzać).
 */
function _gzBrushFrameData(w, h, el) {
    const intensity = _gzStyleIntensity(el);
    const seed = _gzStrToSeed((el && el.id ? String(el.id) : 'x') + ':brushframe:' + Math.round(w) + 'x' + Math.round(h) + ':' + Math.round(intensity * 100));
    const PRNG = _gzMulberry32(seed);
    const ms = Math.min(w, h);
    const t = Math.max(10, ms * (0.045 + intensity * 0.025));
    const outerAmp = Math.max(1.2, ms * 0.008 * (0.6 + intensity));
    const innerAmp = Math.max(2.0, ms * 0.020 * (0.6 + intensity));
    const step = Math.max(3, ms * 0.012);

    const tracePts = (rx, ry, rw, rh, amp) => {
        const pts = [];
        pts.push([rx, ry + (PRNG() - 0.5) * 2 * amp]);
        for (let xx = rx + step; xx < rx + rw; xx += step) { pts.push([xx, ry + (PRNG() - 0.5) * 2 * amp]); }
        for (let yy = ry; yy < ry + rh; yy += step) { pts.push([rx + rw + (PRNG() - 0.5) * 2 * amp, yy]); }
        for (let xx = rx + rw; xx > rx; xx -= step) { pts.push([xx, ry + rh + (PRNG() - 0.5) * 2 * amp]); }
        for (let yy = ry + rh; yy > ry; yy -= step) { pts.push([rx + (PRNG() - 0.5) * 2 * amp, yy]); }
        return pts;
    };
    const outerPts = tracePts(0, 0, w, h, outerAmp);
    const innerPts = tracePts(t, t, w - 2 * t, h - 2 * t, innerAmp);
    return { outerPts, innerPts, t, ms };
}

function _gzPtsToPath(ctx, pts) {
    if (!pts || !pts.length) { return; }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) { ctx.lineTo(pts[i][0], pts[i][1]); }
    ctx.closePath();
}

/** Path zewnętrznego (perturbowanego) konturu ramki pędzlowej — do clipFunc obrazu. */
function gzBrushFrameOuterPath(ctx, w, h, el) {
    const { outerPts } = _gzBrushFrameData(w, h, el);
    _gzPtsToPath(ctx, outerPts);
}

/**
 * Rysuje warstwę „ramki PĘDZLOWEJ" (Freepik-style brush frame): biały pierścień z perturbowanymi
 * krawędziami zewnętrzną i wewnętrzną. Zewnętrzny path JEST IDENTYCZNY z `gzBrushFrameOuterPath`
 * — wymaga tego clipFunc obrazu (zdjęcie nie wygląda spod ramki w „dziurach" perturbacji).
 */
function gzDrawBrushFrameRing(ctx, w, h, el) {
    const { outerPts, innerPts, ms } = _gzBrushFrameData(w, h, el);
    ctx.beginPath();
    _gzPtsToPath(ctx, outerPts);
    _gzPtsToPath(ctx, innerPts);
    ctx.fillStyle = '#ffffff';
    ctx.fill('evenodd');
    // Cieniutka ciemna kreska wewnątrz (efekt drukowanej farby)
    ctx.beginPath();
    _gzPtsToPath(ctx, innerPts);
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = Math.max(0.5, ms * 0.0015);
    ctx.stroke();
}

/** Najmniejsza odległość punktu (px,py) od odcinka (ax,ay)-(bx,by) + rzut tego punktu na odcinek. */
function gzPointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) { return [Math.hypot(px - ax, py - ay), [ax, ay]]; }
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const sx = ax + t * dx, sy = ay + t * dy;
    return [Math.hypot(px - sx, py - sy), [sx, sy]];
}

/** Zwraca string SVG path danego kształtu w boksie [0,0,w,h] (do K.Path / drawSvgPath). */
function gzShapeSvgPath(shape, w, h, el) {
    const cmds = _gzShapeCommands(shape, w, h, el);
    let out = '';
    for (const c of cmds) {
        const op = c[0];
        if (op === 'Z') { out += 'Z '; continue; }
        out += op + ' ' + c.slice(1).map((n) => n.toFixed(2)).join(' ') + ' ';
    }
    return out.trim();
}

/** Ścieżka SVG zaokrąglonego prostokąta (układ SVG: origin lewy-górny, oś Y w dół). */
/** Rysuje ścieżkę zaokrąglonego prostokąta na canvas (do clipFunc Konva). */
function gzRoundedRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (r <= 0.5) { ctx.rect(x, y, w, h); return; }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function pdfRoundedRectPath(w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    return `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
}

function hexToRgb01(hex) {
    hex = String(hex || '#000');
    if (hex[0] === '#') hex = hex.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const n = parseInt(hex, 16);
    if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** Liniowa interpolacja kolorów RGB. Zwraca hex '#rrggbb'. */
function lerpColorHex(a, b, t) {
    const ca = hexToRgb01(a), cb = hexToRgb01(b);
    const r = Math.round((ca.r + (cb.r - ca.r) * t) * 255);
    const g = Math.round((ca.g + (cb.g - ca.g) * t) * 255);
    const bl = Math.round((ca.b + (cb.b - ca.b) * t) * 255);
    return '#' + [r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Konfiguracja gradientu Konva dla prostokąta w×h, z pól prefix+Type/From/To/Angle elementu. */
function gradientFillCfg(el, w, h, prefix) {
    const type = el[prefix + 'Type'];
    if (type !== 'linear' && type !== 'radial') { return null; }
    const from = el[prefix + 'From'] || '#e9eef5';
    const to = el[prefix + 'To'] || '#1a56db';
    const angle = el[prefix + 'Angle'] || 0;
    const stops = [0, from, 1, to];
    if (type === 'linear') {
        const ang = (angle % 360) * Math.PI / 180;
        const cx = (w || 0) / 2, cy = (h || 0) / 2;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        const half = Math.abs(dx) * (w || 0) / 2 + Math.abs(dy) * (h || 0) / 2;
        return {
            fillLinearGradientStartPoint: { x: cx - dx * half, y: cy - dy * half },
            fillLinearGradientEndPoint:   { x: cx + dx * half, y: cy + dy * half },
            fillLinearGradientColorStops: stops,
        };
    }
    const cx = (w || 0) / 2, cy = (h || 0) / 2;
    const r = Math.sqrt(cx * cx + cy * cy);
    return {
        fillRadialGradientStartPoint: { x: cx, y: cy }, fillRadialGradientStartRadius: 0,
        fillRadialGradientEndPoint:   { x: cx, y: cy }, fillRadialGradientEndRadius: r,
        fillRadialGradientColorStops: stops,
    };
}

/** Wsteczna kompatybilność: rect używa prefiksu „gradient". */
function rectGradientConfig(el) { return gradientFillCfg(el, el.width, el.height, 'gradient'); }
/** Gradient tła tekstu — prefix „bgGradient", wymiary = box ramki tekstu. */
function textBgGradientConfig(el) { return gradientFillCfg(el, el.width, el.height, 'bgGradient'); }
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Zestaw znaków specjalnych do palety (kropki/kwadraciki/strzałki/✓/typografia/matematyka/symbole).
const SPECIAL_CHARS = [
    { group: 'Punktory i kształty', chars: ['•', '◦', '‣', '▪', '▫', '■', '□', '●', '○', '◆', '◇', '★', '☆', '✦', '❖', '▶', '◀', '▲', '▼', '♦', '♥', '♣', '♠'] },
    { group: 'Zaznaczenia', chars: ['✓', '✔', '✗', '✘', '☑', '☐', '☒', '✱', '✳'] },
    { group: 'Strzałki', chars: ['→', '←', '↑', '↓', '↔', '↕', '⇒', '⇐', '⇑', '⇓', '➜', '➤', '↪', '↩'] },
    { group: 'Typografia', chars: ['—', '–', '…', '«', '»', '„', '”', '‚', '’', '§', '¶', '†', '‡', '·', '※', '№'] },
    { group: 'Matematyka', chars: ['×', '÷', '±', '≈', '≠', '≤', '≥', '∞', '√', '°', '½', '¼', '¾', '⅓', '²', '³', 'π'] },
    { group: 'Symbole', chars: ['€', '£', '$', '©', '®', '™', '☀', '☁', '☂', '☃', '♪', '♫', '☺', '☹', '✉', '✏', '✂', '☎', '⚡'] },
];

const LOREM_PL = 'W tym miejscu wpisz treść artykułu. Możesz tu opisać szkolne wydarzenie, '
    + 'przeprowadzony wywiad albo relację z wycieczki. Tekst automatycznie układa się w kolumnach, '
    + 'więc wystarczy, że zaczniesz pisać. Pamiętaj o krótkich akapitach — czyta się je łatwiej.\n\n'
    + 'Dwuklik na ramce pozwala edytować tekst bezpośrednio na stronie. W panelu po prawej zmienisz '
    + 'czcionkę, rozmiar, wyrównanie oraz liczbę szpalt. Zdjęcia dodasz przyciskiem aparatu na pasku narzędzi.\n\n'
    + 'Gdy gazetka będzie gotowa, użyj eksportu „PDF do druku (składanka)", wydrukuj dwustronnie, '
    + 'złóż kartki na pół i zszyj — strony ułożą się w odpowiedniej kolejności.';
