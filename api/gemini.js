export default async function handler(req, res) {
    // CORS für lokale Entwicklung
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'GEMINI_API_KEY ist nicht konfiguriert.' });
    }

    const { model = 'gemini-flash-lite-latest', payload } = req.body;

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        let response, data;
        // Bei Überlastung (503) bis zu 3x wiederholen
        for (let attempt = 0; attempt < 3; attempt++) {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            data = await response.json();
            if (response.status !== 503) break;
            await new Promise(r => setTimeout(r, 1500));
        }
        if (!response.ok) {
            return res.status(response.status).json(data);
        }

        return res.status(200).json(data);
    } catch (err) {
        console.error('Gemini Proxy Error:', err);
        return res.status(500).json({ error: 'Interner Proxy-Fehler' });
    }
}
