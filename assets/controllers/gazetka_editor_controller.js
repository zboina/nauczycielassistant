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
    static targets = ['container', 'thumbs', 'title', 'file', 'status', 'props', 'zoomLabel', 'pageInfo', 'gridBtn', 'undoBtn', 'redoBtn', 'cropContainer', 'cropZoom'];
    static values = {
        saveUrl: String,
        uploadUrl: String,
        aiTextUrl: String,
        aiImageUrl: String,
        stockSearchUrl: String,
        stockImportUrl: String,
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

        // Klik w puste tło = odznacz.
        this.stage.on('mousedown touchstart', (e) => {
            if (e.target === this.stage || e.target.name() === 'page-bg') {
                this.select(null);
            }
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
        if (!this.selectedId) { this.tr.nodes([]); this.ui.draw(); return; }
        const node = this.layer.findOne('#' + this.selectedId);
        this.tr.nodes(node ? [node] : []);
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
            node.on('mousedown touchstart', () => this.select(el.id));
            node.on('dragend', () => {
                el.x = round(node.x());
                el.y = round(node.y());
                this.markDirty();
                this.renderPage();      // reflow tekstu oblewającego po przesunięciu (np. obrazka)
                this.select(el.id);
            });
            node.on('transformend', () => this.commitTransform(el, node));
            if (el.type === 'text') {
                node.on('transform', () => this.liveReflowText(el, node));
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

    /** Prostokąty obrazów (w układzie lokalnym ramki tekstu) nakładające się na ramkę — z marginesem. */
    imageExclusions(el) {
        if (el.wrapImages === false) return [];
        const gutter = 9;
        const res = [];
        for (const o of this.page().elements) {
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

    /** Najszerszy wolny przedział poziomy [x0,x1] w wierszu [yTop,yBot] w obrębie [rx0,rx1] po odjęciu obrazów; null gdy brak miejsca. */
    freeIntervalInRange(yTop, yBot, rx0, rx1, exclusions) {
        const blocked = [];
        for (const ex of exclusions) {
            if (ex.y0 < yBot && ex.y1 > yTop) {
                const bx0 = Math.max(rx0, ex.x0), bx1 = Math.min(rx1, ex.x1);
                if (bx1 > bx0) blocked.push([bx0, bx1]);
            }
        }
        if (!blocked.length) return [rx0, rx1];

        blocked.sort((a, b) => a[0] - b[0]);
        const free = [];
        let cur = rx0;
        for (const [bx0, bx1] of blocked) {
            if (bx0 > cur) free.push([cur, bx0]);
            cur = Math.max(cur, bx1);
        }
        if (cur < rx1) free.push([cur, rx1]);

        let best = null, bw = 8; // ignoruj skrawki węższe niż 8 pt
        for (const f of free) {
            const w = f[1] - f[0];
            if (w > bw) { bw = w; best = f; }
        }
        return best;
    }

    /** Łamanie tekstu ze zmienną szerokością wiersza, z przepływem przez kolumny (1–3) i oblewaniem obrazów. Zwraca true przy przepełnieniu. */
    renderFlowedText(group, el, exclusions, lineHpx, common, align, cols, colW, gap) {
        const ctx = this.measureCtx();
        ctx.font = this.fontShorthand(el);
        const spaceW = ctx.measureText(' ').width || (el.fontSize || 14) * 0.28;
        const frameH = el.height;
        const colX = (c) => c * (colW + gap);

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

        const paragraphs = (el.text || '').split('\n');
        for (let p = 0; p < paragraphs.length && !overflow; p++) {
            const words = paragraphs[p].split(/\s+/).filter(Boolean);
            if (words.length === 0) {
                if (!ensureRoom()) { overflow = true; break; }
                y += lineHpx; // pusty wiersz / odstęp akapitu
                continue;
            }

            let i = 0;
            while (i < words.length) {
                if (!ensureRoom()) { overflow = true; break; }
                const cx0 = colX(col);
                const seg = this.freeIntervalInRange(y, y + lineHpx, cx0, cx0 + colW, exclusions);
                if (!seg) { y += lineHpx; continue; } // wiersz zasłonięty przez obraz — w dół

                const availW = seg[1] - seg[0];
                const lineWords = [];
                let w = 0;
                while (i < words.length) {
                    const wordW = ctx.measureText(words[i]).width;
                    const add = (lineWords.length ? spaceW : 0) + wordW;
                    if (w + add > availW && lineWords.length > 0) break;
                    lineWords.push(words[i]); w += add; i++;
                }
                if (lineWords.length === 0) { lineWords.push(words[i]); i++; } // słowo szersze niż wiersz

                const lastLineOfPara = i >= words.length;
                this.renderTextLine(group, lineWords, ctx, seg[0], y, availW, spaceW, common, align, lastLineOfPara);
                y += lineHpx;
            }
        }
        return overflow;
    }

    /** Renderuje jeden wiersz w przedziale [x0, x0+availW] z wybranym wyrównaniem (w tym justowaniem). */
    renderTextLine(group, words, ctx, x0, y, availW, spaceW, common, align, isLastLine) {
        const K = this.Konva;
        if (align === 'justify' && !isLastLine && words.length > 1) {
            const ww = words.map((w) => ctx.measureText(w).width);
            const natural = ww.reduce((a, b) => a + b, 0) + spaceW * (words.length - 1);
            if (natural >= availW * 0.5) {
                const extra = Math.max(0, (availW - natural) / (words.length - 1));
                let x = 0;
                for (let w = 0; w < words.length; w++) {
                    group.add(new K.Text({ x: x0 + x, y, text: words[w], align: 'left', wrap: 'none', ...common }));
                    x += ww[w] + spaceW + extra;
                }
                return;
            }
        }
        const a = align === 'justify' ? 'left' : align;
        group.add(new K.Text({ x: x0, y, width: availW, text: words.join(' '), align: a, wrap: 'none', ...common }));
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

    select(id) {
        this.selectedId = id;
        this.reattachTransformer();
        this.syncProps();
    }

    selectedEl() {
        return this.page().elements.find((e) => e.id === this.selectedId) || null;
    }

    commitTransform(el, node) {
        const sx = node.scaleX();
        const sy = node.scaleY();
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
        this.markDirty();
        this.renderPage();
        this.select(el.id);
    }

    // ─── Edycja tekstu (textarea overlay) ───────────────────

    editText(el, node) {
        const box = node.getClientRect({ relativeTo: this.stage });
        const stageBox = this.stage.container().getBoundingClientRect();
        const z = this.zoom;

        node.hide();
        this.tr.nodes([]);
        this.layer.draw();

        const cap = Math.round(window.innerHeight * 0.6);
        const ta = document.createElement('textarea');
        document.body.appendChild(ta);
        ta.value = el.text || '';
        Object.assign(ta.style, {
            position: 'absolute',
            left: (stageBox.left + window.scrollX + box.x * z) + 'px',
            top: (stageBox.top + window.scrollY + box.y * z) + 'px',
            width: Math.max(80, box.width * z) + 'px',
            minHeight: Math.max(40, box.height * z) + 'px',
            maxHeight: cap + 'px',
            fontSize: (el.fontSize || 14) * z + 'px',
            fontFamily: el.fontFamily || 'Georgia',
            lineHeight: el.lineHeight || 1.3,
            color: el.fill || '#1a2330',
            textAlign: el.align === 'justify' ? 'left' : (el.align || 'left'),
            padding: '2px 4px', margin: '0', border: '2px solid #1a56db', borderRadius: '3px',
            background: '#fff', outline: 'none', resize: 'vertical',
            zIndex: 2000, overflow: 'auto', boxSizing: 'border-box',
            boxShadow: '0 6px 18px rgba(0,0,0,.18)',
        });

        // Auto-rozrost do treści (z przewijaniem powyżej limitu) — żeby długi tekst dało się edytować w całości.
        const grow = () => {
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight + 2, cap) + 'px';
        };
        ta.addEventListener('input', grow);
        ta.focus();
        ta.select();
        grow();

        const commit = () => {
            el.text = ta.value;
            ta.remove();
            this.markDirty();
            this.renderPage();
            this.select(el.id);
        };
        ta.addEventListener('blur', commit);
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); ta.blur(); }
        });
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
        const el = this.selectedEl();
        if (!el) return;
        this.page().elements = this.page().elements.filter((e) => e.id !== el.id);
        this.select(null);
        this.markDirty();
        this.renderPage();
    }

    duplicateSelected() {
        const el = this.selectedEl();
        if (!el) return;
        const copy = JSON.parse(JSON.stringify(el));
        copy.id = uid();
        copy.x = (el.x || 0) + 16;
        copy.y = (el.y || 0) + 16;
        this.addElement(copy);
    }

    // ─── Schowek (kopiuj / wytnij / wklej — także między stronami) ───

    copySelected() {
        const el = this.selectedEl();
        if (!el) return;
        this.clipboard = JSON.parse(JSON.stringify(el));
        this.statusTarget.textContent = 'Skopiowano element — wklej (Ctrl+V) na dowolnej stronie';
    }

    cutSelected() {
        const el = this.selectedEl();
        if (!el) return;
        this.clipboard = JSON.parse(JSON.stringify(el));
        this.page().elements = this.page().elements.filter((e) => e.id !== el.id);
        this.select(null);
        this.markDirty();
        this.renderPage();
        this.statusTarget.textContent = 'Wycięto element — wklej (Ctrl+V) na dowolnej stronie';
    }

    pasteClipboard() {
        if (!this.clipboard) return;
        const copy = JSON.parse(JSON.stringify(this.clipboard));
        copy.id = uid();
        copy.x = clamp((copy.x || 0) + 16, 0, Math.max(0, this.pageW - 20));
        copy.y = clamp((copy.y || 0) + 16, 0, Math.max(0, this.pageH - 20));
        this.addElement(copy); // wkleja na BIEŻĄCĄ stronę
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

        panel.querySelectorAll('[data-for]').forEach((group) => {
            const types = group.dataset.for.split(' ');
            const show = el && (types.includes('any') || types.includes(el.type));
            group.style.display = show ? '' : 'none';
        });
        panel.querySelector('[data-empty]')?.style.setProperty('display', el ? 'none' : '');

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

    async exportBooklet() { await this.exportPdf(true); }
    async exportSequential() { await this.exportPdf(false); }

    async exportPdf(booklet) {
        if (!window.PDFLib) { alert('Nie załadowano biblioteki pdf-lib.'); return; }
        this.statusTarget.textContent = 'Generowanie PDF…';

        try {
            if (this.dirty) await this.save();
            await this.preloadAllImages();
            if (document.fonts && document.fonts.ready) await document.fonts.ready; // czcionki Google na wydruku

            const pixelRatio = 2.5; // ~180 DPI
            const pagePng = this.doc.pages.map((_, i) => this.pageToDataURL(i, pixelRatio));

            const { PDFDocument } = window.PDFLib;
            const pdf = await PDFDocument.create();
            const embeds = [];
            for (const url of pagePng) embeds.push(await pdf.embedPng(url));

            if (!booklet) {
                // Po kolei: jedna strona A5 na stronę PDF.
                for (const img of embeds) {
                    const p = pdf.addPage([this.pageW, this.pageH]);
                    p.drawImage(img, { x: 0, y: 0, width: this.pageW, height: this.pageH });
                }
            } else {
                // Składka: 2 strony A5 na arkuszu A4 poziomo, w kolejności do druku dwustronnego.
                const total = this.padToFour(embeds.length);
                const sheets = total / 4;
                const at = (n) => (n >= 1 && n <= embeds.length) ? embeds[n - 1] : null; // 1-indeks; brakujące = puste
                const sheetW = this.pageW * 2;
                const sheetH = this.pageH;

                const drawSide = (left, right) => {
                    const p = pdf.addPage([sheetW, sheetH]);
                    if (left) p.drawImage(left, { x: 0, y: 0, width: this.pageW, height: this.pageH });
                    if (right) p.drawImage(right, { x: this.pageW, y: 0, width: this.pageW, height: this.pageH });
                };

                for (let s = 0; s < sheets; s++) {
                    drawSide(at(total - 2 * s), at(1 + 2 * s));        // przód arkusza
                    drawSide(at(2 + 2 * s), at(total - 1 - 2 * s));    // tył arkusza
                }
            }

            const bytes = await pdf.save();
            const fname = (this.titleTarget.value || 'gazetka').replace(/[^\p{L}\p{N}_-]+/gu, '_')
                + (booklet ? '_do_druku' : '_po_kolei') + '.pdf';
            this.downloadBlob(new Blob([bytes], { type: 'application/pdf' }), fname);
            this.statusTarget.textContent = 'PDF gotowy: ' + fname;
        } catch (e) {
            this.statusTarget.textContent = 'Błąd PDF: ' + e.message;
            console.error(e);
        }
    }

    padToFour(n) { return Math.ceil(n / 4) * 4; }

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

    async generateAiImage() {
        const root = this.element;
        const prompt = (root.querySelector('[data-ai="imgPrompt"]').value || '').trim();
        if (!prompt) { this.setAiStatus('img', 'Opisz, co ma przedstawiać obraz.', true); return; }

        const style = root.querySelector('[data-ai="imgStyle"]').value;
        this.setAiBusy('img', true);
        this.setAiStatus('img', 'Generuję obraz… (może potrwać do ~1 min)');
        try {
            const res = await fetch(this.aiImageUrlValue, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ prompt, style }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Błąd generowania.');

            const maxW = this.pageW * 0.6, maxH = this.pageH * 0.5;
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

        const ratio = el.width / el.height;
        const maxCropW = Math.min(natW, natH * ratio);
        let cw, ch, cx, cy;
        if (el.crop && el.crop.width) {
            cw = el.crop.width; ch = el.crop.height; cx = el.crop.x; cy = el.crop.y;
        } else {
            cw = maxCropW; ch = cw / ratio; cx = (natW - cw) / 2; cy = (natH - ch) / 2;
        }

        const cropImg = new K.Image({ image: img, draggable: true });
        layer.add(cropImg);
        const border = new K.Rect({ stroke: '#ffffff', strokeWidth: 2, dash: [6, 4], listening: false, shadowColor: '#000', shadowBlur: 3 });
        layer.add(border);

        this._cropStage = stage;
        this._crop = { el, img, natW, natH, dispScale, ratio, maxCropW, cw, ch, cx, cy, cropImg, border, layer, sw, sh };

        cropImg.dragBoundFunc((pos) => {
            const c = this._crop;
            const rw = c.cw * c.dispScale, rh = c.ch * c.dispScale;
            return { x: clamp(pos.x, 0, c.sw - rw), y: clamp(pos.y, 0, c.sh - rh) };
        });
        cropImg.on('dragmove', () => {
            const c = this._crop;
            c.cx = cropImg.x() / c.dispScale;
            c.cy = cropImg.y() / c.dispScale;
            this.syncCrop();
        });

        this.syncCrop();
        if (this.hasCropZoomTarget) this.cropZoomTarget.value = String((maxCropW / cw).toFixed(2));
    }

    syncCrop() {
        const c = this._crop;
        if (!c) return;
        // utrzymaj proporcje ramki i zmieść kadr w obrazie
        c.cw = clamp(c.cw, 16, c.natW);
        c.ch = c.cw / c.ratio;
        if (c.ch > c.natH) { c.ch = c.natH; c.cw = c.ch * c.ratio; }
        c.cx = clamp(c.cx, 0, c.natW - c.cw);
        c.cy = clamp(c.cy, 0, c.natH - c.ch);

        const x = c.cx * c.dispScale, y = c.cy * c.dispScale, w = c.cw * c.dispScale, h = c.ch * c.dispScale;
        c.cropImg.setAttrs({ x, y, width: w, height: h, crop: { x: c.cx, y: c.cy, width: c.cw, height: c.ch } });
        c.border.setAttrs({ x, y, width: w, height: h });
        c.layer.batchDraw();
    }

    setCropZoom(e) {
        const c = this._crop;
        if (!c) return;
        const z = Math.max(1, parseFloat(e.target.value) || 1);
        const cenX = c.cx + c.cw / 2, cenY = c.cy + c.ch / 2;
        c.cw = c.maxCropW / z;
        c.ch = c.cw / c.ratio;
        c.cx = cenX - c.cw / 2;
        c.cy = cenY - c.ch / 2;
        this.syncCrop();
    }

    applyCrop() {
        const c = this._crop;
        if (!c) return;
        c.el.crop = { x: Math.round(c.cx), y: Math.round(c.cy), width: Math.round(c.cw), height: Math.round(c.ch) };
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
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
            if (document.querySelector('.modal.show')) return; // nie przechwytuj skrótów przy otwartym oknie

            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId) {
                e.preventDefault(); this.deleteSelected();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                e.preventDefault(); this.redo();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault(); this.save();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && this.selectedId) {
                e.preventDefault(); this.duplicateSelected();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && this.selectedId) {
                e.preventDefault(); this.copySelected();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && this.selectedId) {
                e.preventDefault(); this.cutSelected();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && this.clipboard) {
                e.preventDefault(); this.pasteClipboard();
            } else if (this.selectedId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                const el = this.selectedEl();
                const step = e.shiftKey ? 10 : 1;
                if (e.key === 'ArrowUp') el.y -= step;
                if (e.key === 'ArrowDown') el.y += step;
                if (e.key === 'ArrowLeft') el.x -= step;
                if (e.key === 'ArrowRight') el.x += step;
                this.markDirty(); this.renderPage(); this.select(el.id);
            }
        };
        window.addEventListener('keydown', this._keyHandler);
    }
}

// ─── Pomocnicze ─────────────────────────────────────────────
function uid() { return 'el_' + Math.random().toString(36).slice(2, 9); }
function round(n) { return Math.round(n); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

const LOREM_PL = 'W tym miejscu wpisz treść artykułu. Możesz tu opisać szkolne wydarzenie, '
    + 'przeprowadzony wywiad albo relację z wycieczki. Tekst automatycznie układa się w kolumnach, '
    + 'więc wystarczy, że zaczniesz pisać. Pamiętaj o krótkich akapitach — czyta się je łatwiej.\n\n'
    + 'Dwuklik na ramce pozwala edytować tekst bezpośrednio na stronie. W panelu po prawej zmienisz '
    + 'czcionkę, rozmiar, wyrównanie oraz liczbę szpalt. Zdjęcia dodasz przyciskiem aparatu na pasku narzędzi.\n\n'
    + 'Gdy gazetka będzie gotowa, użyj eksportu „PDF do druku (składanka)", wydrukuj dwustronnie, '
    + 'złóż kartki na pół i zszyj — strony ułożą się w odpowiedniej kolejności.';
