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
    static targets = ['container', 'thumbs', 'title', 'file', 'status', 'props', 'zoomLabel', 'pageInfo', 'gridBtn', 'undoBtn', 'redoBtn', 'cropContainer', 'toolbar'];
    static values = {
        saveUrl: String,
        uploadUrl: String,
        aiTextUrl: String,
        aiImageUrl: String,
        stockSearchUrl: String,
        stockImportUrl: String,
        mediaListUrl: String,
        mediaDeleteUrl: String,
        blocksUrl: String,
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

        this.current = 0;
        this.selectedId = null;
        this.selectedIds = [];      // pełna selekcja (1 = pojedyncza, >1 = wielokrotna/grupa)
        this.imageCache = {};
        this.dirty = false;
        this.clipboard = null;
        this.gridSize = 20;
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
        if (mediaModal) mediaModal.addEventListener('shown.bs.modal', () => this.loadMedia());

        // Magazyn bloków — odśwież paletę po otwarciu okna.
        const blocksModal = document.getElementById('gzBlocksModal');
        if (blocksModal) blocksModal.addEventListener('shown.bs.modal', () => this.renderBlockPalette());

        // Po załadowaniu czcionek (Google Fonts) przerysuj — inaczej Konva mierzy/rysuje fallbackiem.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => { this.renderPage(); this.renderThumbs(); });
        }
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
        this.ui = new K.Layer();
        this.stage.add(this.layer);
        this.stage.add(this.ui);

        this.tr = new K.Transformer({
            rotateEnabled: true,
            keepRatio: false,
            anchorSize: 9,
            borderStroke: '#1a56db',
            anchorStroke: '#1a56db',
            anchorCornerRadius: 2,
            padding: 2,
            // Przyciąganie rozmiaru/pozycji do siatki podczas skalowania.
            boundBoxFunc: (oldBox, newBox) => {
                if (!this.snap || Math.abs(newBox.rotation) > 0.01) return newBox;
                const g = this.gridSize * this.zoom;
                return {
                    ...newBox,
                    x: Math.round(newBox.x / g) * g,
                    y: Math.round(newBox.y / g) * g,
                    width: Math.max(g, Math.round(newBox.width / g) * g),
                    height: Math.max(g, Math.round(newBox.height / g) * g),
                };
            },
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
            const node = this.buildNode(el, true);
            if (node) this.layer.add(node);
        }

        this.drawPageNumber(this.layer, this.current);
        this.layer.draw();
        this.reattachTransformer();
        this.updatePageInfo();
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
        this.tr.nodes(nodes);
        this.ui.draw();
    }

    // ─── Budowa węzłów ──────────────────────────────────────

    buildNode(el, interactive) {
        const K = this.Konva;
        let node;

        if (el.type === 'text') {
            node = this.buildTextGroup(el, interactive);
        } else if (el.type === 'image' || el.type === 'icon') {
            node = new K.Image({
                width: el.width, height: el.height,
                image: this.getImage(el.src),
                crop: (el.type === 'image' && el.crop) ? el.crop : undefined,
            });
            if (el.shadow) {
                node.shadowColor('rgba(0,0,0,0.35)');
                node.shadowBlur(10);
                node.shadowOffset({ x: 0, y: 4 });
            }
        } else if (el.type === 'rect') {
            node = new K.Rect({
                width: el.width, height: el.height,
                fill: el.fill || '#e9eef5',
                stroke: el.stroke || null,
                strokeWidth: el.strokeWidth || 0,
                cornerRadius: el.cornerRadius || 0,
            });
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
            node.dragBoundFunc((pos) => this.snapPos(pos));
            node.on('mousedown touchstart', (e) => {
                const additive = !!(e.evt && e.evt.shiftKey);
                this.select(el.id, additive);
            });
            node.on('dragstart', () => {
                // Przeciąganie grupy/wielu zaznaczonych razem — zapamiętaj pozycje startowe.
                if (this.selectedIds.length > 1 && this.selectedIds.includes(el.id)) {
                    this._groupDrag = {};
                    for (const id of this.selectedIds) {
                        const n = this.layer.findOne('#' + id);
                        if (n) this._groupDrag[id] = { x: n.x(), y: n.y() };
                    }
                } else {
                    this._groupDrag = null;
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

        // Tło ramki (do robienia kolorowych „wstawek").
        if (el.bgOn && el.bgFill) {
            group.add(new K.Rect({
                x: 0, y: 0, width: el.width, height: el.height,
                fill: el.bgFill, cornerRadius: Math.max(0, el.bgRadius || 0), listening: false,
                ...shadow,
            }));
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
            const exAdj = pad > 0
                ? exclusions.map((e) => ({ x0: e.x0 - pad, x1: e.x1 - pad, y0: e.y0 - pad, y1: e.y1 - pad }))
                : exclusions;
            const tgroup = new K.Group({ x: pad, y: pad });
            group.add(tgroup);
            isOverflow = this.renderFlowedText(tgroup, inner, exAdj, lineHpx, common, align, cols, colW, gap);
        } else if (Array.isArray(el.runs) && el.runs.length) {
            // Tekst z pogrubieniem/kursywą fragmentów (runs) — renderowanie słowo po słowie.
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
        const gutter = 9;
        const res = [];
        for (const o of els) {
            if (o.rotation || o.id === el.id) continue;
            // Zdjęcia oblewają domyślnie; ikony tylko po włączeniu „Oblewaj tekstem".
            const wraps = o.type === 'image' ? (o.wrapText !== false)
                : (o.type === 'icon' ? o.wrapText === true : false);
            if (!wraps) continue;
            const ix1 = o.x + o.width, iy1 = o.y + o.height;
            const tx1 = el.x + el.width, ty1 = el.y + el.height;
            // brak nałożenia?
            if (ix1 <= el.x || o.x >= tx1 || iy1 <= el.y || o.y >= ty1) continue;
            res.push({
                x0: (o.x - el.x) - gutter,
                x1: (ix1 - el.x) + gutter,
                y0: (o.y - el.y) - gutter,
                y1: (iy1 - el.y) + gutter,
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
                const bx0 = Math.max(rx0, ex.x0), bx1 = Math.min(rx1, ex.x1);
                if (bx1 > bx0) blocked.push([bx0, bx1]);
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
                            // Pojedyncze słowo szersze niż pasek: wymuś tylko w pełnej szerokości (dłuższe niż kolumna);
                            // w wąskim pasku obok obrazu zostaw je na pełny wiersz niżej.
                            if (lineWords.length === 0 && fullWidth) { lineWords.push(words[i]); w += add; i++; }
                            break;
                        }
                        lineWords.push(words[i]); w += add; i++;
                    }
                    if (!lineWords.length) continue; // nic nie weszło w ten pasek — spróbuj następnego

                    // Justujemy/zwijamy każdy pasek tak, by „domykał się" do krawędzi obrazu/marginesu, gdy tekst trwa dalej.
                    const moreWords = i < words.length;
                    this.renderRichLine(group, { words: lineWords, lastOfPara: !moreWords }, el, seg[0], y, availW, spaceW, align, !moreWords, common);
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
        const pushWord = () => { if (cur) { paras[paras.length - 1].push({ segs: cur }); cur = null; } };

        for (const r of runs) {
            const b = baseB || !!r.b;
            const i = baseI || !!r.i;
            for (const ch of String(r.t)) {
                if (ch === '\n') { pushWord(); paras.push([]); continue; }
                if (/\s/.test(ch)) { pushWord(); continue; }
                if (!cur) cur = [];
                const last = cur[cur.length - 1];
                if (last && last.bold === b && last.italic === i) last.text += ch;
                else cur.push({ text: ch, bold: b, italic: i });
            }
        }
        pushWord();
        return paras;
    }

    segFont(el, bold, italic) {
        return (italic ? 'italic ' : '') + (bold ? 'bold ' : '')
            + (el.fontSize || 14) + 'px ' + (el.fontFamily || 'Georgia');
    }

    segStyle(bold, italic) {
        return ((italic ? 'italic ' : '') + (bold ? 'bold' : '')).trim() || 'normal';
    }

    /** Szerokość słowa = suma szerokości jego segmentów (każdy mierzony własną czcionką). Wynik cache'owany w word._w. */
    measureWord(word, el) {
        const ctx = this.measureCtx();
        let w = 0;
        for (const s of word.segs) { ctx.font = this.segFont(el, s.bold, s.italic); w += ctx.measureText(s.text).width; }
        word._w = w;
        return w;
    }

    /** Rysuje słowo od (x,y): kolejne segmenty z własnym fontStyle, dosuwane wg zmierzonej szerokości. */
    renderWord(group, word, el, x, y, common) {
        const K = this.Konva;
        const ctx = this.measureCtx();
        let cx = x;
        for (const s of word.segs) {
            ctx.font = this.segFont(el, s.bold, s.italic);
            group.add(new K.Text({ x: cx, y, text: s.text, wrap: 'none', ...common, fontStyle: this.segStyle(s.bold, s.italic) }));
            cx += ctx.measureText(s.text).width;
        }
    }

    /** Łamie słowa (z richWords) na linie szerokości colW. Zwraca {lines:[{words,lastOfPara}], spaceW}. */
    wrapRichWords(paras, colW, el) {
        const ctx = this.measureCtx();
        ctx.font = this.segFont(el, false, false);
        const spaceW = ctx.measureText(' ').width || (el.fontSize || 14) * 0.28;
        const lines = [];
        for (const words of paras) {
            if (words.length === 0) { lines.push({ words: [], lastOfPara: true }); continue; }
            let line = [], w = 0;
            for (const word of words) {
                const wW = this.measureWord(word, el);
                const add = (line.length ? spaceW : 0) + wW;
                if (w + add > colW && line.length > 0) { lines.push({ words: line, lastOfPara: false }); line = [word]; w = wW; }
                else { line.push(word); w += add; }
            }
            lines.push({ words: line, lastOfPara: true });
        }
        return { lines, spaceW };
    }

    /** Renderuje sformatowany tekst w kolumnach (1–3) z wyrównaniem w pionie i poziomie. Zwraca true przy przepełnieniu. */
    renderRichColumns(group, el, cols, colW, gap, lineHpx, align, valign, common) {
        const { lines, spaceW } = this.wrapRichWords(this.richWords(el), colW, el);
        const fit = Math.max(1, Math.floor((el.height + 1) / lineHpx));
        const balanced = Math.max(1, Math.ceil(lines.length / cols));
        const perCol = Math.min(balanced, fit);
        const overflow = lines.length > cols * perCol;

        const usedLines = cols === 1 ? Math.min(lines.length, fit) : Math.min(perCol, lines.length);
        let yOffset = 0;
        const contentH = usedLines * lineHpx;
        if (valign === 'middle') yOffset = Math.max(0, (el.height - contentH) / 2);
        else if (valign === 'bottom') yOffset = Math.max(0, el.height - contentH);

        const lastVisible = Math.min(lines.length, cols * perCol) - 1;
        for (let c = 0; c < cols; c++) {
            const cx = c * (colW + gap);
            for (let i = 0; i < perCol; i++) {
                const gi = c * perCol + i;
                if (gi >= lines.length) break;
                const line = lines[gi];
                if (!line.words.length) continue;
                this.renderRichLine(group, line, el, cx, yOffset + i * lineHpx, colW, spaceW, align, gi === lastVisible, common);
            }
        }
        return overflow;
    }

    /** Renderuje jedną sformatowaną linię z wyrównaniem (w tym justowaniem przez rozsuwanie słów). */
    renderRichLine(group, line, el, cx, y, colW, spaceW, align, isLastVisible, common) {
        const words = line.words;
        const widths = words.map((w) => (w._w != null ? w._w : this.measureWord(w, el)));
        const natural = widths.reduce((a, b) => a + b, 0) + spaceW * (words.length - 1);

        if (align === 'justify' && !isLastVisible && !line.lastOfPara && words.length > 1 && natural >= colW * 0.5) {
            const extra = (colW - natural) / (words.length - 1);
            let x = cx;
            for (let k = 0; k < words.length; k++) { this.renderWord(group, words[k], el, x, y, common); x += widths[k] + spaceW + extra; }
            return;
        }

        let x = cx;
        if (align === 'center') x = cx + (colW - natural) / 2;
        else if (align === 'right') x = cx + (colW - natural);
        for (let k = 0; k < words.length; k++) { this.renderWord(group, words[k], el, x, y, common); x += widths[k] + spaceW; }
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

        // Edytowalne pole z formatowaniem fragmentów (bold/italic).
        const ed = document.createElement('div');
        ed.contentEditable = 'true';
        ed.spellcheck = false;
        ed.innerHTML = this.htmlFromRuns(el);
        document.body.appendChild(ed);
        Object.assign(ed.style, {
            position: 'absolute',
            left: left + 'px',
            top: top + 'px',
            width: Math.max(80, box.width * z) + 'px',
            minHeight: Math.max(40, box.height * z) + 'px',
            maxHeight: cap + 'px',
            fontSize: (el.fontSize || 14) * z + 'px',
            fontFamily: el.fontFamily || 'Georgia',
            lineHeight: el.lineHeight || 1.3,
            color: el.fill || '#1a2330',
            textAlign: el.align === 'justify' ? 'left' : (el.align || 'left'),
            padding: '2px 4px', margin: '0', border: '2px solid #1a56db', borderRadius: '3px',
            background: '#fff', outline: 'none', whiteSpace: 'pre-wrap', wordWrap: 'break-word',
            zIndex: 2000, overflowY: 'auto', boxSizing: 'border-box',
            boxShadow: '0 6px 18px rgba(0,0,0,.18)',
        });

        // Pasek B / I nad polem (mousedown→preventDefault, by nie tracić zaznaczenia/fokusu).
        const bar = document.createElement('div');
        Object.assign(bar.style, {
            position: 'absolute', left: left + 'px', top: Math.max(0, top - 34) + 'px',
            display: 'flex', gap: '4px', padding: '3px', background: '#1a2330',
            borderRadius: '6px', zIndex: 2001, boxShadow: '0 4px 12px rgba(0,0,0,.25)',
        });
        const mkBtn = (label, cmd, fontStyle) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            Object.assign(b.style, {
                width: '28px', height: '26px', border: 'none', borderRadius: '4px',
                background: '#2b3954', color: '#fff', cursor: 'pointer',
                fontFamily: 'Georgia, serif', fontSize: '15px', lineHeight: '1', ...fontStyle,
            });
            b.addEventListener('mousedown', (e) => {
                e.preventDefault();
                document.execCommand(cmd, false, null);
                ed.focus();
            });
            return b;
        };
        bar.appendChild(mkBtn('B', 'bold', { fontWeight: 'bold' }));
        bar.appendChild(mkBtn('I', 'italic', { fontStyle: 'italic' }));
        document.body.appendChild(bar);

        ed.focus();
        // Zaznacz całość przy wejściu.
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(ed);
        sel.removeAllRanges();
        sel.addRange(range);

        let done = false;
        const commit = () => {
            if (done) return;
            done = true;
            const { text, runs } = this.runsFromHtml(ed);
            el.text = text;
            if (runs.some((r) => r.b || r.i)) el.runs = runs;
            else delete el.runs;
            ed.remove();
            bar.remove();
            this.markDirty();
            this.renderPage();
            this.select(el.id);
        };
        ed.addEventListener('blur', commit);
        ed.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); ed.blur(); }
        });
    }

    /** Buduje HTML pola edycji z el.runs (lub el.text) — <b>/<i> + <br> na nowe linie. */
    htmlFromRuns(el) {
        const runs = (Array.isArray(el.runs) && el.runs.length) ? el.runs : [{ t: el.text || '' }];
        let html = '';
        for (const r of runs) {
            let t = escapeHtml(r.t).replace(/\n/g, '<br>');
            if (r.i) t = '<i>' + t + '</i>';
            if (r.b) t = '<b>' + t + '</b>';
            html += t;
        }
        return html || '';
    }

    /** Serializuje contenteditable do {text, runs}. <b>/<strong>/font-weight→bold, <i>/<em>/font-style→italic, bloki/BR→\n. */
    runsFromHtml(root) {
        const runs = [];
        let started = false;
        const push = (t, b, i) => {
            if (!t) return;
            const last = runs[runs.length - 1];
            if (last && !!last.b === !!b && !!last.i === !!i) last.t += t;
            else runs.push({ t, b: b || undefined, i: i || undefined });
            started = true;
        };
        const walk = (node, b, i) => {
            for (const child of node.childNodes) {
                if (child.nodeType === 3) { push(child.nodeValue, b, i); continue; }
                if (child.nodeType !== 1) continue;
                const tag = child.tagName;
                if (tag === 'BR') {
                    // Pomiń „filler" BR będący jedynym/ostatnim dzieckiem bloku.
                    if (child.nextSibling) push('\n', b, i);
                    continue;
                }
                const st = child.style || {};
                const fw = st.fontWeight;
                const nb = b || tag === 'B' || tag === 'STRONG' || fw === 'bold' || (fw && parseInt(fw, 10) >= 600);
                const ni = i || tag === 'I' || tag === 'EM' || st.fontStyle === 'italic';
                if (/^(DIV|P)$/.test(tag) && started) push('\n', b, i);
                walk(child, nb, ni);
            }
        };
        walk(root, false, false);
        const text = runs.map((r) => r.t).join('');
        return { text, runs };
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
        this.fileTarget.click();
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

            // Dopasuj do max połowy szerokości/wysokości strony, zachowując proporcje.
            const maxW = this.pageW * 0.6;
            const maxH = this.pageH * 0.5;
            let w = data.width || 240;
            let h = data.height || 180;
            const ratio = Math.min(maxW / w, maxH / h, 1);
            w = round(w * ratio); h = round(h * ratio);

            this.addElement({
                id: uid(), type: 'image',
                x: round((this.pageW - w) / 2), y: 80, width: w, height: h,
                rotation: 0, opacity: 1, src: data.url, wrapText: true,
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
        const els = this.selectedElements();
        if (!els.length) return;
        const block = this.cloneBlock(els, 16, 16);
        for (const c of block) this.page().elements.push(c);
        this.selectAll(block.map((c) => c.id));
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
        const el = this.selectedEl();
        const panel = this.propsTarget;
        const multi = this.selectedIds.length > 1;

        panel.querySelectorAll('[data-for]').forEach((group) => {
            const types = group.dataset.for.split(' ');
            const show = el && (types.includes('any') || types.includes(el.type));
            group.style.display = show ? '' : 'none';
        });
        // Panel selekcji wielokrotnej (grupowanie / blok).
        const mp = panel.querySelector('[data-multi]');
        if (mp) {
            mp.style.display = multi ? '' : 'none';
            if (multi) {
                const cnt = mp.querySelector('[data-multi-count]');
                if (cnt) cnt.textContent = this.selectedIds.length;
                const grouped = this.selectedElements().some((e) => e.groupId);
                const gb = mp.querySelector('[data-act="group"]'), ub = mp.querySelector('[data-act="ungroup"]');
                if (gb) gb.disabled = false;
                if (ub) ub.disabled = !grouped;
            }
        }
        panel.querySelector('[data-empty]')?.style.setProperty('display', (el || multi) ? 'none' : '');

        if (!el) return;
        panel.querySelectorAll('[data-prop]').forEach((input) => {
            const key = input.dataset.prop;
            const has = el[key] !== undefined;
            if (input.type === 'checkbox') input.checked = has ? !!el[key] : false;
            else input.value = has ? el[key] : '';
        });
    }

    onPropInput(e) {
        const input = e.target.closest('[data-prop]');
        if (!input) return;
        const el = this.selectedEl();
        if (!el) return;

        const key = input.dataset.prop;
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (input.dataset.type === 'number') value = parseFloat(value) || 0;
        el[key] = value;

        // Edycja zwykłego tekstu w panelu zastępuje całość — kasujemy formatowanie fragmentów (runs).
        // Pogrubienie/kursywę fragmentu ustawia się przez dwuklik w ramkę i zaznaczenie tekstu.
        if (key === 'text') delete el.runs;

        // Ikona: zmiana koloru kreski / wypełnienia → przebuduj SVG.
        if (el.type === 'icon' && (key === 'iconColor' || key === 'iconFill' || key === 'iconFilled')) {
            this.regenIconSrc(el);
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

    renderThumbs() {
        const wrap = this.thumbsTarget;
        wrap.innerHTML = '';
        this.doc.pages.forEach((p, i) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'gz-thumb' + (i === this.current ? ' gz-thumb--active' : '');
            item.innerHTML = `<span class="gz-thumb__sheet"></span><span class="gz-thumb__num">${i + 1}</span>`;
            item.addEventListener('click', () => this.goTo(i));
            wrap.appendChild(item);
        });
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

    removePage() {
        if (this.doc.pages.length <= 1) return;
        if (!confirm('Usunąć bieżącą stronę wraz z zawartością?')) return;
        this.doc.pages.splice(this.current, 1);
        this.current = Math.max(0, this.current - 1);
        this.markDirty();
        this.select(null);
        this.renderThumbs();
        this.renderPage();
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
    updateZoomLabel() {
        if (this.hasZoomLabelTarget) this.zoomLabelTarget.textContent = Math.round(this.zoom * 100) + '%';
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

    snapPos(pos) {
        if (!this.snap) return pos;
        const g = this.gridSize * this.zoom;
        return { x: Math.round(pos.x / g) * g, y: Math.round(pos.y / g) * g };
    }

    toggleGrid() {
        this.snap = !this.snap;
        if (this.hasGridBtnTarget) this.gridBtnTarget.classList.toggle('active', this.snap);
        this.renderPage();
    }

    setGridSize(e) {
        const v = parseInt(e.target.value, 10);
        if (v > 0) {
            this.gridSize = v;
            this.renderPage();
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
            const node = this.buildNode(el, false);
            if (node) layer.add(node);
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
            if (document.fonts && document.fonts.ready) await document.fonts.ready;

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
            const needRaster = (idx) => (this.doc.pages[idx].elements || []).some((el) => el.rotation);
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
        const c = el.crop ? `${el.crop.x},${el.crop.y},${el.crop.width},${el.crop.height}` : '';
        return (el.type) + '|' + (el.src || '') + '|' + c;
    }

    /** Rysuje obraz/ikonę (z kadrem) na canvas i zwraca {url, jpeg}. */
    async pdfImageData(el) {
        let img = this.imageCache[el.src];
        if (!img) img = this.getImage(el.src);
        if (!img.complete || !img.naturalWidth) {
            await new Promise((res) => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); setTimeout(res, 4000); });
        }
        if (!img.naturalWidth) return null;

        let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
        if (el.type === 'image' && el.crop && el.crop.width) { sx = el.crop.x; sy = el.crop.y; sw = el.crop.width; sh = el.crop.height; }

        let cw, ch;
        if (el.type === 'icon') { const sc = 4; cw = Math.max(8, Math.round((el.width || 64) * sc)); ch = Math.max(8, Math.round((el.height || 64) * sc)); }
        else { const cap = 2200, r = Math.min(1, cap / Math.max(sw, sh)); cw = Math.max(1, Math.round(sw * r)); ch = Math.max(1, Math.round(sh * r)); }

        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);

        const jpeg = el.type === 'image' && /\.jpe?g($|\?)/i.test(el.src || '');
        return { url: jpeg ? cv.toDataURL('image/jpeg', 0.9) : cv.toDataURL('image/png'), jpeg };
    }

    /** Rysuje całą stronę dokumentu na stronie PDF z offsetem (ox,oy w pt, układ od lewego-dolnego rogu obszaru). */
    pdfDrawPage(page, box, ox, oy, pageIndex) {
        page.drawRectangle({ x: ox, y: oy, width: this.pageW, height: this.pageH, color: this.pdfRgb(box.background || '#ffffff') });
        for (const el of (box.elements || [])) {
            const top = oy + this.pageH - (el.y + (el.height || 0)); // dolna krawędź elementu w układzie PDF
            if (el.type === 'rect') {
                const opts = { x: ox + el.x, y: top, width: el.width, height: el.height, color: this.pdfRgb(el.fill || '#e9eef5') };
                if (el.stroke && (el.strokeWidth || 0) > 0) { opts.borderColor = this.pdfRgb(el.stroke); opts.borderWidth = el.strokeWidth; }
                page.drawRectangle(opts);
            } else if (el.type === 'line') {
                page.drawLine({ start: { x: ox + el.x, y: oy + this.pageH - el.y }, end: { x: ox + el.x + el.width, y: oy + this.pageH - el.y }, thickness: el.strokeWidth || 2, color: this.pdfRgb(el.stroke || '#1a2330') });
            } else if (el.type === 'image' || el.type === 'icon') {
                const im = this._pdfImg[this.pdfImgKey(el)];
                if (im) page.drawImage(im, { x: ox + el.x, y: top, width: el.width, height: el.height });
            } else if (el.type === 'text') {
                this.pdfDrawTextEl(page, el, box.elements, ox, oy);
            }
        }
        this.pdfDrawPageNumber(page, ox, oy, pageIndex);
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
    pdfDrawTextEl(page, el, els, ox, oy) {
        if (el.bgOn && el.bgFill) {
            page.drawRectangle({ x: ox + el.x, y: oy + this.pageH - (el.y + el.height), width: el.width, height: el.height, color: this.pdfRgb(el.bgFill) });
        }
        if (el.borderOn && (el.borderWidth || 0) > 0) {
            const sw = el.borderWidth;
            page.drawRectangle({ x: ox + el.x + sw / 2, y: oy + this.pageH - (el.y + el.height) + sw / 2, width: el.width - sw, height: el.height - sw, borderColor: this.pdfRgb(el.borderColor || '#1a56db'), borderWidth: sw });
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

        this._pctx = { ox: ox + el.x + pad, oyB: oy, top: el.y + pad };
        if (ex.length) {
            const exAdj = pad > 0 ? ex.map((e) => ({ x0: e.x0 - pad, x1: e.x1 - pad, y0: e.y0 - pad, y1: e.y1 - pad })) : ex;
            this.pdfRenderFlowed(page, inner, exAdj, lineHpx, align, cols, colW, gap);
        } else {
            this.pdfRenderColumns(page, inner, cols, colW, gap, lineHpx, align, valign);
        }
    }

    pdfMeasureWord(word, el) {
        const s = el.fontSize || 14; let w = 0;
        for (const sg of word.segs) w += this.pdfFontFor(el.fontFamily, sg.bold, sg.italic).widthOfTextAtSize(sg.text, s);
        word._w = w; return w;
    }

    pdfSpaceW(el) {
        const f = this.pdfFontFor(el.fontFamily, false, false);
        return f.widthOfTextAtSize(' ', el.fontSize || 14) || (el.fontSize || 14) * 0.28;
    }

    /** Rysuje słowo (segmenty z własnym stylem) od (x, yTop) w układzie ramki; przelicza na współrzędne PDF. */
    pdfDrawWord(page, word, el, x, yTop) {
        const s = el.fontSize || 14;
        const col = this.pdfRgb(el.fill || '#1a2330');
        const c = this._pctx;
        const y = c.oyB + this.pageH - (c.top + yTop + s * PDF_ASCENT);
        let cx = c.ox + x;
        for (const sg of word.segs) {
            const f = this.pdfFontFor(el.fontFamily, sg.bold, sg.italic);
            page.drawText(sg.text, { x: cx, y, size: s, font: f, color: col });
            cx += f.widthOfTextAtSize(sg.text, s);
        }
    }

    pdfWrapRich(paras, colW, el) {
        const sp = this.pdfSpaceW(el);
        const lines = [];
        for (const words of paras) {
            if (!words.length) { lines.push({ words: [], lastOfPara: true }); continue; }
            let line = [], w = 0;
            for (const word of words) {
                const ww = this.pdfMeasureWord(word, el);
                const add = (line.length ? sp : 0) + ww;
                if (w + add > colW && line.length) { lines.push({ words: line, lastOfPara: false }); line = [word]; w = ww; }
                else { line.push(word); w += add; }
            }
            lines.push({ words: line, lastOfPara: true });
        }
        return { lines, sp };
    }

    pdfRenderLine(page, line, el, cx, y, colW, sp, align, isLastVisible) {
        const ws = line.words;
        const wd = ws.map((w) => (w._w != null ? w._w : this.pdfMeasureWord(w, el)));
        const nat = wd.reduce((a, b) => a + b, 0) + sp * (ws.length - 1);
        if (align === 'justify' && !isLastVisible && !line.lastOfPara && ws.length > 1 && nat >= colW * 0.5) {
            const extra = (colW - nat) / (ws.length - 1);
            let x = cx;
            for (let k = 0; k < ws.length; k++) { this.pdfDrawWord(page, ws[k], el, x, y); x += wd[k] + sp + extra; }
            return;
        }
        let x = cx;
        if (align === 'center') x = cx + (colW - nat) / 2;
        else if (align === 'right') x = cx + (colW - nat);
        for (let k = 0; k < ws.length; k++) { this.pdfDrawWord(page, ws[k], el, x, y); x += wd[k] + sp; }
    }

    pdfRenderColumns(page, el, cols, colW, gap, lineHpx, align, valign) {
        const { lines, sp } = this.pdfWrapRich(this.richWords(el), colW, el);
        const fit = Math.max(1, Math.floor((el.height + 1) / lineHpx));
        const balanced = Math.max(1, Math.ceil(lines.length / cols));
        const perCol = Math.min(balanced, fit);
        const used = cols === 1 ? Math.min(lines.length, fit) : Math.min(perCol, lines.length);
        let yOff = 0;
        const contentH = used * lineHpx;
        if (valign === 'middle') yOff = Math.max(0, (el.height - contentH) / 2);
        else if (valign === 'bottom') yOff = Math.max(0, el.height - contentH);
        const lastVis = Math.min(lines.length, cols * perCol) - 1;
        for (let c = 0; c < cols; c++) {
            const cx = c * (colW + gap);
            for (let i = 0; i < perCol; i++) {
                const gi = c * perCol + i;
                if (gi >= lines.length) break;
                const ln = lines[gi];
                if (!ln.words.length) continue;
                this.pdfRenderLine(page, ln, el, cx, yOff + i * lineHpx, colW, sp, align, gi === lastVis);
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
                        if (w + add > availW) { if (lineWords.length === 0 && fullWidth) { lineWords.push(words[i]); w += add; i++; } break; }
                        lineWords.push(words[i]); w += add; i++;
                    }
                    if (!lineWords.length) continue;
                    const moreWords = i < words.length;
                    this.pdfRenderLine(page, { words: lineWords, lastOfPara: !moreWords }, el, seg[0], y, availW, sp, align, !moreWords);
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
                width: w, height: h, rotation: 0, opacity: 1, src: data.url, wrapText: true,
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
                wrapText: false,
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

    // ─── Grafiki (Pixabay) ──────────────────────────────────

    setStockStatus(msg, err) {
        const el = this.element.querySelector('[data-stock="status"]');
        if (el) { el.textContent = msg; el.className = 'small mb-2 ' + (err ? 'text-danger' : 'text-secondary'); }
    }

    stockKey(e) { if (e.key === 'Enter') { e.preventDefault(); this.searchStock(); } }

    async searchStock() {
        const root = this.element;
        const q = (root.querySelector('[data-stock="query"]').value || '').trim();
        const type = root.querySelector('[data-stock="type"]').value;
        const results = root.querySelector('[data-stock="results"]');
        if (!q) { this.setStockStatus('Wpisz, czego szukasz.', true); return; }
        this.setStockStatus('Szukam…');
        results.innerHTML = '';
        try {
            const res = await fetch(this.stockSearchUrlValue + '?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(type));
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
                width: w, height: h, rotation: 0, opacity: 1, src: data.url, wrapText: true,
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

    /** Wstawia grafikę z magazynu na bieżącą stronę (jak upload / Pixabay). */
    insertMedia(it) {
        const maxW = this.pageW * 0.6, maxH = this.pageH * 0.5;
        let w = it.width || 320, h = it.height || 320;
        const ratio = Math.min(maxW / w, maxH / h, 1);
        w = round(w * ratio); h = round(h * ratio);
        this.addElement({
            id: uid(), type: 'image', x: round((this.pageW - w) / 2), y: 80,
            width: w, height: h, rotation: 0, opacity: 1, src: it.url, wrapText: true,
        });
        const cb = document.querySelector('#gzMediaModal [data-bs-dismiss="modal"]');
        if (cb) cb.click();
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
};

/** Nazwa pliku kroju (bez .ttf) dla rodziny+stylu, z fallbackami; null gdy brak w manifeście. */
function pdfFileFor(manifest, family, bold, italic) {
    const id = PDF_FONT_MAP[family] || 'gelasio';
    const w = bold ? '700' : '400';
    const s = italic ? 'i' : '';
    const cands = [`${id}-${w}${s}`, `${id}-${w}`, `${id}-400${s}`, `${id}-400`, 'gelasio-400'];
    return cands.find((c) => manifest.has(c)) || null;
}

function hexToRgb01(hex) {
    hex = String(hex || '#000');
    if (hex[0] === '#') hex = hex.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const n = parseInt(hex, 16);
    if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const LOREM_PL = 'W tym miejscu wpisz treść artykułu. Możesz tu opisać szkolne wydarzenie, '
    + 'przeprowadzony wywiad albo relację z wycieczki. Tekst automatycznie układa się w kolumnach, '
    + 'więc wystarczy, że zaczniesz pisać. Pamiętaj o krótkich akapitach — czyta się je łatwiej.\n\n'
    + 'Dwuklik na ramce pozwala edytować tekst bezpośrednio na stronie. W panelu po prawej zmienisz '
    + 'czcionkę, rozmiar, wyrównanie oraz liczbę szpalt. Zdjęcia dodasz przyciskiem aparatu na pasku narzędzi.\n\n'
    + 'Gdy gazetka będzie gotowa, użyj eksportu „PDF do druku (składanka)", wydrukuj dwustronnie, '
    + 'złóż kartki na pół i zszyj — strony ułożą się w odpowiedniej kolejności.';
