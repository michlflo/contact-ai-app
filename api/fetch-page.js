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
    const pages = [target.href, base + '/impressum', base + '/kontakt'];
    const texts = await Promise.all(pages.map(get));
    const text = texts.map(clean).filter(Boolean).join('\n---\n').slice(0, 15000);
    if (!text) return res.status(502).json({ error: 'Webseite konnte nicht geladen werden' });
    return res.status(200).json({ text });
}