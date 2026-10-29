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

        let body = html
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<(div|section|aside)[^>]*(?:cookie|consent|mod-cr|gdpr)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
            .replace(/<[^>]+>/g, ' ');

        body = decodeEntities(body).replace(/\s+/g, ' ').trim();

        const impressumIdx = body.search(/\b(Medieninhaber|Für den Inhalt verantwortlich|Urheber\s*\/\s*Herausgeber|Informationspflicht|Unternehmensgegenstand|Geschäftsführer|Geschäftsführung|Inhaber)\b/i);
        let relevantBody = body;
        if (impressumIdx > 400) {
            const fromImpressum = body.slice(Math.max(0, impressumIdx - 200));
            if (fromImpressum.length <= maxLen) {
                relevantBody = fromImpressum;
            } else {
                const headPart = Math.floor(maxLen * 0.65);
                const tailPart = maxLen - headPart;
                relevantBody = fromImpressum.slice(0, headPart) + ' ... ' + fromImpressum.slice(fromImpressum.length - tailPart);
            }
        } else if (body.length > maxLen) {
            const half = Math.floor(maxLen * 0.65);
            const tail = maxLen - half;
            relevantBody = body.slice(0, half) + ' ... ' + body.slice(body.length - tail);
        }

        const ohMatch = body.match(/.{0,40}\b(?:Öffnungszeiten|Oeffnungszeiten|Bürozeiten|Geschäftszeiten)\b[\s\S]{0,220}/i);
        const ohSnippet = ohMatch ? 'Gefundene Öffnungszeiten im Text: ' + ohMatch[0].replace(/\s+/g, ' ').trim() : '';

        return [metaHeader, ohSnippet, relevantBody.slice(0, maxLen)].filter(Boolean).join('\n');
    };

    let lastFetchError = '';
    const fetchRawHtml = async (u, timeoutMs) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetch(u, {
                signal: ctrl.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'de-AT,de;q=0.9,en;q=0.8'
                }
            });
            if (!r.ok) {
                lastFetchError = `HTTP ${r.status}`;
                return '';
            }
            const buf = await r.arrayBuffer();
            const ct = r.headers.get('content-type') || '';
            const headAscii = new TextDecoder('ascii').decode(buf.slice(0, 2048));
            const isLatin1 = /charset\s*=\s*(?:iso-8859-1|windows-1252|latin1)/i.test(ct) || /charset\s*=\s*(?:iso-8859-1|windows-1252|latin1)/i.test(headAscii);
            let decoded = new TextDecoder(isLatin1 ? 'windows-1252' : 'utf-8').decode(buf);
            if (/Ã[¤¶¼„–œŸ]/.test(decoded)) {
                try {
                    const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0) & 0xff);
                    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    decoded = fixed;
                } catch {}
            }
            return decoded;
        } catch (err) {
            lastFetchError = (err?.cause?.message || err?.cause?.code || err?.message || 'fetch error');
            return '';
        } finally {
            clearTimeout(t);
        }
    };

    // Falls der Zielserver Cloud-/AWS-IPs (Vercel) blockiert (Geo-Block/Firewall), neuesten Snapshot aus dem Internet Archive (Wayback Machine) laden
    const fetchWaybackHtml = async (u) => {
        try {
            const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(u)}&output=json&filter=statuscode:200&limit=-1`;
            const cr = await fetch(cdxUrl, { signal: AbortSignal.timeout(5000) });
            if (!cr.ok) return '';
            const rows = await cr.json();
            if (!Array.isArray(rows) || !rows[1]) return '';
            const [, timestamp, origUrl] = rows[1];
            return await fetchRawHtml(`https://web.archive.org/web/${timestamp}id_/${origUrl}`, 6000);
        } catch {
            return '';
        }
    };

    const get = async (u, timeoutMs = 4500) => {
        const direct = await fetchRawHtml(u, timeoutMs);
        if (direct) return direct;
        return await fetchWaybackHtml(u);
    };

    // Entdecke echte Impressums- und Kontakt-Links direkt aus dem HTML der Startseite
    const discoverSubpageUrl = (html, baseUrl, pattern, fallbackPath) => {
        if (html) {
            const linkRegex = /<a\s+[^>]*?href=["']([^"'#]+)["'][^>]*?>([\s\S]*?)<\/a>/gi;
            let m;
            const candidates = [];
            while ((m = linkRegex.exec(html)) !== null) {
                const href = m[1].trim();
                const linkText = m[2].replace(/<[^>]+>/g, ' ').trim();
                if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
                if (pattern.test(href) || pattern.test(linkText)) {
                    try {
                        const resolved = new URL(href, baseUrl);
                        if (resolved.hostname === baseUrl.hostname && !/datenschutz|privacy/i.test(resolved.pathname)) {
                            candidates.push(resolved.href);
                        }
                    } catch {}
                }
            }
            if (candidates.length > 0) return candidates[0];
        }
        return baseUrl.origin + fallbackPath;
    };

    // 1. Lade zuerst die eingegebene Seite selbst
    let mainHtml = await fetchRawHtml(target.href, 4500);
    let blockedDirect = false;
    if (!mainHtml) {
        blockedDirect = true;
        mainHtml = await fetchWaybackHtml(target.href);
    }

    // 2. Ermittle die tatsächlichen URLs für Impressum und Kontakt (z. B. /content/de/impressum/)
    const impressumUrl = discoverSubpageUrl(mainHtml, target, /\b(impressum|imprint|offenlegung)\b/i, '/impressum');
    const kontaktUrl = discoverSubpageUrl(mainHtml, target, /\b(kontakt|service-kontakt|contact)\b/i, '/kontakt');

    const loadSub = (u) => blockedDirect ? fetchWaybackHtml(u) : get(u, 4500);

    const [impressumHtml, kontaktHtml] = await Promise.all([
        impressumUrl !== target.href ? loadSub(impressumUrl) : Promise.resolve(''),
        kontaktUrl !== target.href && kontaktUrl !== impressumUrl ? loadSub(kontaktUrl) : Promise.resolve('')
    ]);

    const sections = [
        { label: 'IMPRESSUM', html: impressumHtml, max: 3500 },
        { label: 'KONTAKT', html: kontaktHtml, max: 2500 },
        { label: 'STARTSEITE', html: mainHtml, max: 3500 },
    ];

    const text = sections
        .map(s => ({ label: s.label, t: clean(s.html, s.max) }))
        .filter(x => x.t)
        .map(x => `[${x.label}]\n${x.t}`)
        .join('\n\n');

    if (!text) return res.status(502).json({ error: 'Webseite konnte nicht geladen werden', detail: lastFetchError });
    return res.status(200).json({ text });
}
