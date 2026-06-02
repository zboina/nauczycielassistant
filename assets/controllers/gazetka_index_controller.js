import { Controller } from '@hotwired/stimulus';

/* Lista gazetek (/gazetka) — rysuje na canvasie podgląd 1. strony z każdej gazetki.
   Korzysta z lekkiego JSON-a wygenerowanego po stronie serwera (GazetkaController::buildPreview):
   rect/line/text + image (URL-e uploadów lub małe SVG data URI; ciężkie data URI → placeholder). */
export default class extends Controller {
    connect() {
        const canvases = this.element.querySelectorAll('.gz-preview-canvas');
        canvases.forEach((c) => this.scheduleDraw(c));

        // Przerysuj przy resize (canvas musi mieć właściwą fizyczną rozdzielczość, by tekst był ostry).
        this._onResize = () => {
            clearTimeout(this._rt);
            this._rt = setTimeout(() => canvases.forEach((c) => this.scheduleDraw(c)), 100);
        };
        window.addEventListener('resize', this._onResize);

        // Doczekaj na fonty Google (Montserrat, Kalam, …) — tekst będzie wtedy renderowany właściwym krojem.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => canvases.forEach((c) => this.scheduleDraw(c)));
        }
    }

    disconnect() {
        if (this._onResize) { window.removeEventListener('resize', this._onResize); }
    }

    scheduleDraw(canvas) {
        // Ustaw fizyczną rozdzielczość proporcjonalną do rozmiaru CSS (× devicePixelRatio).
        const cssW = canvas.clientWidth || 240;
        const cssH = canvas.clientHeight || 340;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        try {
            this.draw(canvas, ctx, cssW, cssH);
        } catch (e) {
            console.warn('gz-preview draw error:', e);
            this.drawError(ctx, cssW, cssH);
        }
    }

    draw(canvas, ctx, W, H) {
        const data = JSON.parse(canvas.dataset.preview || '{}');
        const pageW = data.pageW || 420;
        const pageH = data.pageH || 595;
        const sx = W / pageW, sy = H / pageH;

        // Tło strony
        ctx.fillStyle = (data.background && /^#[0-9a-fA-F]{3,8}$/.test(data.background)) ? data.background : '#ffffff';
        ctx.fillRect(0, 0, W, H);

        const els = Array.isArray(data.elements) ? data.elements : [];
        for (const el of els) {
            const op = (typeof el.o === 'number') ? el.o : 1;
            ctx.save();
            ctx.globalAlpha = Math.max(0, Math.min(1, op));
            const x = (el.x || 0) * sx, y = (el.y || 0) * sy;
            const w = (el.w || 0) * sx, h = (el.h || 0) * sy;
            if (el.r) {
                ctx.translate(x, y);
                ctx.rotate((el.r * Math.PI) / 180);
                ctx.translate(-x, -y);
            }

            if (el.t === 'rect') {
                this.drawRect(ctx, x, y, w, h, el, sx);
            } else if (el.t === 'line') {
                this.drawLine(ctx, x, y, w, el, sx);
            } else if (el.t === 'text') {
                this.drawText(ctx, x, y, w, h, el, sx, sy);
            } else if (el.t === 'image' || el.t === 'icon') {
                this.drawImage(canvas, ctx, x, y, w, h, el);
            }
            ctx.restore();
        }
    }

    drawRect(ctx, x, y, w, h, el, sx) {
        const r = Math.max(0, Math.min(Math.min(w, h) / 2, (el.cr || 0) * sx));
        const fill = this.safeColor(el.fill);
        const stroke = this.safeColor(el.stroke);
        const sw = (el.sw || 0) * sx;
        if (fill || stroke) {
            this.roundedPath(ctx, x, y, w, h, r);
            if (fill) { ctx.fillStyle = fill; ctx.fill(); }
            if (stroke && sw > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = sw; ctx.stroke(); }
        }
    }

    drawLine(ctx, x, y, w, el, sx) {
        const sw = Math.max(0.5, (el.sw || 1) * sx);
        ctx.strokeStyle = this.safeColor(el.stroke) || '#000';
        ctx.lineWidth = sw;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
        ctx.stroke();
    }

    drawText(ctx, x, y, w, h, el, sx, sy) {
        const fs = Math.max(4, (el.fs || 12) * sy);
        const fst = (el.fst || 'normal').toLowerCase();
        const bold = fst.includes('bold');
        const italic = fst.includes('italic');
        const ff = el.ff || 'Arial';
        ctx.font = (italic ? 'italic ' : '') + (bold ? '700 ' : '400 ') + fs + 'px "' + ff + '", Arial, sans-serif';
        ctx.fillStyle = this.safeColor(el.fill) || '#1a2330';
        ctx.textBaseline = 'top';
        const text = (el.text || '').replace(/\s+/g, ' ').trim();
        if (!text) { return; }
        // Bardzo prosty wrap (podgląd): łamie po słowach na szerokość ramki, do wysokości ramki.
        const lh = fs * (el.lh || 1.3);
        const words = text.split(' ');
        let line = '', cy = y;
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        for (const word of words) {
            const test = line ? (line + ' ' + word) : word;
            const tw = ctx.measureText(test).width;
            if (tw > w && line) {
                this.drawTextLine(ctx, line, x, cy, w, el.align);
                cy += lh;
                if (cy > y + h - fs * 0.6) { return; }
                line = word;
            } else {
                line = test;
            }
        }
        if (line) {
            this.drawTextLine(ctx, line, x, cy, w, el.align);
        }
    }

    drawTextLine(ctx, line, x, y, w, align) {
        let tx = x;
        if (align === 'center') {
            tx = x + (w - ctx.measureText(line).width) / 2;
        } else if (align === 'right') {
            tx = x + (w - ctx.measureText(line).width);
        }
        ctx.fillText(line, tx, y);
    }

    drawImage(canvas, ctx, x, y, w, h, el) {
        if (!el.src) {
            this.drawImagePlaceholder(ctx, x, y, w, h);
            return;
        }
        // Cache img per canvas, by uniknąć ponownego ładowania przy redraw.
        canvas._imgs = canvas._imgs || {};
        let img = canvas._imgs[el.src];
        if (img && img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, x, y, w, h);
            return;
        }
        // Placeholder na czas ładowania
        this.drawImagePlaceholder(ctx, x, y, w, h);
        if (img) { return; } // już się ładuje — kolejny redraw narysuje
        img = new Image();
        img.crossOrigin = 'anonymous';
        canvas._imgs[el.src] = img;
        img.onload = () => this.scheduleDraw(canvas);
        img.onerror = () => { /* zostaje placeholder */ };
        img.src = el.src;
    }

    drawImagePlaceholder(ctx, x, y, w, h) {
        ctx.fillStyle = '#e7ecf3';
        ctx.fillRect(x, y, w, h);
        // mały krzyżyk znaczący „obraz"
        ctx.strokeStyle = '#cdd5e0';
        ctx.lineWidth = Math.max(0.5, Math.min(w, h) * 0.012);
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
        ctx.moveTo(x + w, y); ctx.lineTo(x, y + h);
        ctx.stroke();
    }

    drawError(ctx, W, H) {
        ctx.fillStyle = '#f6f8fa';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#8593a5';
        ctx.font = '12px Arial, sans-serif';
        ctx.fillText('— podgląd niedostępny —', 12, 14);
    }

    safeColor(c) {
        if (typeof c !== 'string') { return null; }
        if (/^#[0-9a-fA-F]{3,8}$/.test(c)) { return c; }
        if (/^rgba?\(/i.test(c)) { return c; }
        if (/^[a-z]+$/i.test(c)) { return c; }
        return null;
    }

    roundedPath(ctx, x, y, w, h, r) {
        ctx.beginPath();
        if (r > 0) {
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
        } else {
            ctx.rect(x, y, w, h);
        }
        ctx.closePath();
    }
}
