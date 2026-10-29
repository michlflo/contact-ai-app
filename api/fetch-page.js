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

    const decodeEntities = (s) => s
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&ndash;|&#8211;/gi, '–')
        .replace(/&mdash;|&#8212;/gi, '—')
        .replace(/&auml;/gi, 'ä').replace(/&Auml;/gi, 'Ä')
        .replace(/&ouml;/gi, 'ö').replace(/&Ouml;/gi, 'Ö')
        .replace(/&uuml;/gi, 'ü').replace(/&Uuml;/gi, 'Ü')
        .replace(/&szlig;/gi, 'ß')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));

    const extractMetaAndContacts = (html) => {
        const metas = [];
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleMatch) metas.push('Titel: ' + decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim()));

        const metaRegex = /<meta\s+[^>]*?(?:name|property)=["']([^"']+)["'][^>]*?content=["']([^"']+)["'][^>]*?>/gi;
        let m;
        while ((m = metaRegex.exec(html)) !== null) {
            const k = m[1].toLowerCase();
            if (/description|keywords|title|publisher|author|og:title|og:description/.test(k)) {
                metas.push(`${m[1]}: ${decodeEntities(m[2])}`);
            }
        }
        // Auch umgekehrte Reihenfolge content=... name=...
        const metaRegex2 = /<meta\s+[^>]*?content=["']([^"']+)["'][^>]*?(?:name|property)=["']([^"']+)["'][^>]*?>/gi;
        while ((m = metaRegex2.exec(html)) !== null) {
            const k = m[2].toLowerCase();
            if (/description|keywords|title|publisher|author|og:title|og:description/.test(k)) {
                metas.push(`${m[2]}: ${decodeEntities(m[1])}`);
            }
        }

        // E-Mail-Adressen im Quelltext finden (auch verschleierte wie office[at]firma.at)
        const normalizedHtml = decodeEntities(html).replace(/\[at\]|\(at\)|\s+at\s+/gi, '@');
        const emailMatches = [...new Set(normalizedHtml.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])]
            .filter(e => !/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(e) && !/q2e\.at|sentry|example|w3\.org/i.test(e));
        if (emailMatches.length) metas.push('Gefundene E-Mail-Adressen: ' + emailMatches.join(', '));

        const telMatches = [...new Set((html.match(/href=["']tel:([^"']+)["']/gi) || []).map(x => x.replace(/href=["']tel:|["']/gi, '')))];
        if (telMatches.length) metas.push('Gefundene Telefon-Links: ' + telMatches.join(', '));

        return metas.join('\n');
    };

    const clean = (html, maxLen) => {
        if (!html) return '';
        const metaHeader = extractMetaAndContacts(html);

        // Entferne Scripts, Styles, Kommentare sowie Cookie-/Consent-Container und große Menüs
        let body = html
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<(div|section|aside)[^>]*(?:cookie|consent|mod-cr|gdpr)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
            .replace(/<[^>]+>/g, ' ');

        body = decodeEntities(body).replace(/\s+/g, ' ').trim();

        // Falls immer noch langer Cookie-Banner-Text am Anfang steht, überspringe ihn bis zum eigentlichen Seiteninhalt
        const impressumIdx = body.search(/\b(Medieninhaber|Für den Inhalt verantwortlich|Informationspflicht|Unternehmensgegenstand|Geschäftsführer|Inhaber)\b/i);
        let relevantBody = body;
        if (impressumIdx > 400) {
            relevantBody = body.slice(Math.max(0, impressumIdx - 200));
        } else if (body.length > maxLen) {
            // Nimm Anfang, Mitte und Ende (Footer enthält oft Adresse/Tel/Öffnungszeiten)
            const half = Math.floor(maxLen * 0.65);
            const tail = maxLen - half;
            relevantBody = body.slice(0, half) + ' ... ' + body.slice(body.length - tail);
        }

        return [metaHeader, relevantBody.slice(0, maxLen)].filter(Boolean).join('\n');
    };

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
    const pages = [
        { label: 'IMPRESSUM', url: base + '/impressum', max: 3500 },
        { label: 'KONTAKT', url: base + '/kontakt', max: 2500 },
        { label: 'STARTSEITE', url: target.href, max: 3500 },
    ];
    const htmls = await Promise.all(pages.map(p => get(p.url)));
    const text = pages
        .map((p, i) => ({ p, t: clean(htmls[i], p.max) }))
        .filter(x => x.t)
        .map(x => `[${x.p.label}]\n${x.t}`)
        .join('\n\n');

    if (!text) return res.status(502).json({ error: 'Webseite konnte nicht geladen werden' });
    return res.status(200).json({ text });
}
