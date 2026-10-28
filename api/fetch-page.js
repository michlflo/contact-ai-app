export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { url } = req.body || {};
    let target;
    try {
        target = new URL(url);
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('bad protocol');
    } catch {
        return res.status(400).json({ error: 'Ungültige URL' });
    }
    // einfacher SSRF-Schutz
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(target.hostname)) {
        return res.status(400).json({ error: 'URL nicht erlaubt' });
    }

    const clean = (html) => html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim();

    const get = async (u) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        try {
            const r = await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (ContactAI)' } });
            if (!r.ok) return '';
            return await r.text();
        } catch { return ''; } finally { clearTimeout(t); }
    };

    const base = target.origin;
    // Impressum/Kontakt zuerst (dort stehen die Kontaktdaten), Startseite zuletzt
    const pages = [
        { label: 'IMPRESSUM', url: base + '/impressum', max: 4000 },
        { label: 'KONTAKT', url: base + '/kontakt', max: 2500 },
        { label: 'STARTSEITE', url: target.href, max: 3500 },
    ];
    const texts = await Promise.all(pages.map(p => get(p.url)));
    const text = pages
        .map((p, i) => ({ p, t: clean(texts[i]) }))
        .filter(x => x.t)
        .map(x => `[${x.p.label}]\n${x.t.slice(0, x.p.max)}`)
        .join('\n\n');    if (!text) return res.status(502).json({ error: 'Webseite konnte nicht geladen werden' });
    return res.status(200).json({ text });
}