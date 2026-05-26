import { Controller } from '@hotwired/stimulus';

/*
 * Import gazetki z pliku .gazetka na LIŚCIE gazetek (/gazetka).
 * Plik czytany jest lokalnie (omija post_max_size), tworzy nową gazetkę,
 * wgrywa grafiki po jednej przez endpoint /upload i otwiera nową gazetkę.
 */
export default class extends Controller {
    static targets = ['file', 'status'];
    static values = { createUrl: String, csrf: String };

    pick() {
        if (this.hasFileTarget) this.fileTarget.click();
    }

    setStatus(msg, err) {
        if (this.hasStatusTarget) {
            this.statusTarget.textContent = msg || '';
            this.statusTarget.className = 'small mt-2 ' + (err ? 'text-danger' : 'text-secondary');
        }
    }

    async onChosen(event) {
        const input = event.target;
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        this.setStatus('Wczytuję projekt…');
        try {
            const bundle = JSON.parse(await file.text());
            const doc = bundle && bundle.doc;
            if (!bundle || bundle.format !== 'gazetka-bundle' || !doc || !Array.isArray(doc.pages)) {
                throw new Error('To nie jest plik projektu gazetki (.gazetka).');
            }

            // 1) Nowa, pusta gazetka.
            const cr = await (await fetch(this.createUrlValue, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ title: bundle.title || 'Gazetka (import)', pageCount: doc.pages.length }),
            })).json();
            if (!cr.ok) throw new Error(cr.error || 'Nie udało się utworzyć gazetki.');

            // 2) Wgraj wbudowane zdjęcia po jednej (ikony svg zostają data URI).
            const photos = new Set();
            for (const p of doc.pages) for (const el of (p.elements || [])) {
                if (el.type === 'image' && typeof el.src === 'string' && /^data:image\/(png|jpe?g|webp|gif)/i.test(el.src)) photos.add(el.src);
            }
            const map = {};
            let done = 0;
            for (const src of photos) {
                this.setStatus('Wgrywam grafiki… (' + (++done) + '/' + photos.size + ')');
                map[src] = await this.uploadDataUri(cr.uploadUrl, src);
            }
            for (const p of doc.pages) for (const el of (p.elements || [])) {
                if (el.type === 'image' && el.src && map[el.src]) el.src = map[el.src];
            }

            // 3) Zapisz lekki dokument i otwórz nową gazetkę.
            const sv = await (await fetch(cr.saveUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ doc, title: bundle.title || 'Gazetka (import)' }),
            })).json();
            if (!sv.ok) throw new Error(sv.error || 'Nie udało się zapisać dokumentu.');

            this.setStatus('Wczytano — otwieram…');
            window.location = cr.editUrl;
        } catch (e) {
            this.setStatus('Błąd: ' + e.message, true);
            alert('Nie udało się wczytać projektu: ' + e.message);
        }
    }

    async uploadDataUri(uploadUrl, dataUri) {
        const blob = await (await fetch(dataUri)).blob();
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const fd = new FormData();
        fd.append('image', blob, 'import.' + ext);
        const data = await (await fetch(uploadUrl, {
            method: 'POST',
            headers: { 'X-CSRF-Token': this.csrfValue, 'X-Requested-With': 'XMLHttpRequest' },
            body: fd,
        })).json();
        if (!data.ok) throw new Error(data.error || 'Błąd wgrywania grafiki.');
        return data.url;
    }
}
