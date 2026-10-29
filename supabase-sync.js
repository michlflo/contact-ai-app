// Speichert die Kontakte in Supabase (Login + Postgres). Ohne Konfiguration läuft die App wie bisher im Arbeitsspeicher.
(function () {
    if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY || !window.supabase) {
        console.info('Supabase nicht konfiguriert - Kontakte werden nicht gespeichert.');
        return;
    }

    const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    const FIELDS = {
        firstName: 'first_name', lastName: 'last_name', organization: 'organization', trade: 'trade',
        scopeOfServices: 'scope_of_services', status: 'status', title: 'title', email: 'email',
        phone: 'phone', website: 'website', address: 'address', openingHours: 'opening_hours', notes: 'notes', createdAt: 'created_at_label'
    };

    const toRow = (c) => {
        const row = { id: c.id, updated_at: new Date().toISOString() };
        for (const [k, col] of Object.entries(FIELDS)) row[col] = c[k] ?? '';
        return row;
    };
    const fromRow = (r) => {
        const c = { id: r.id };
        for (const [k, col] of Object.entries(FIELDS)) c[k] = r[col] ?? '';
        return c;
    };
    const fingerprint = (c) => JSON.stringify(Object.keys(FIELDS).map(k => c[k] ?? ''));

    let saved = new Map();      // id -> fingerprint des zuletzt gespeicherten Stands
    let ready = false;
    let timer = null;
    let syncing = false;

    const toast = (msg, type) => { if (typeof showToast === 'function') showToast(msg, type); };

    async function sync() {
        if (!ready || syncing) return;
        syncing = true;
        try {
            const current = new Map(contacts.map(c => [c.id, c]));
            const upserts = contacts.filter(c => saved.get(c.id) !== fingerprint(c));
            const deletes = [...saved.keys()].filter(id => !current.has(id));

            if (upserts.length) {
                const { error } = await sb.from('contacts').upsert(upserts.map(toRow));
                if (error) throw error;
                upserts.forEach(c => saved.set(c.id, fingerprint(c)));
            }
            if (deletes.length) {
                const { error } = await sb.from('contacts').delete().in('id', deletes);
                if (error) throw error;
                deletes.forEach(id => saved.delete(id));
            }
        } catch (err) {
            console.error('Supabase sync error:', err);
            toast('Speichern in der Datenbank fehlgeschlagen.', 'error');
        } finally {
            syncing = false;
        }
    }

    function schedule() {
        if (!ready) return;
        clearTimeout(timer);
        timer = setTimeout(sync, 600);
    }

    // Jede Änderung ruft renderContacts() auf -> daran hängen wir das Speichern
    const originalRender = renderContacts;
    renderContacts = function () {
        originalRender.apply(this, arguments);
        schedule();
    };

    async function loadContacts() {
        const { data, error } = await sb.from('contacts').select('*').order('created_at', { ascending: false });
        if (error) { toast('Laden aus der Datenbank fehlgeschlagen.', 'error'); console.error(error); return; }
        contacts = data.map(fromRow);
        saved = new Map(contacts.map(c => [c.id, fingerprint(c)]));
        ready = true;
        originalRender();
        if (typeof renderMatrixView === 'function') renderMatrixView();
    }

    // ---- Login-Overlay ----
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-family:inherit';
    overlay.innerHTML = `
        <form id="sb-login" style="background:#fff;padding:2rem;border-radius:1rem;box-shadow:0 10px 30px rgba(0,0,0,.1);width:min(92vw,360px);display:flex;flex-direction:column;gap:.75rem">
            <h2 style="font-size:1.25rem;font-weight:700">Anmelden</h2>
            <input id="sb-email" type="email" required placeholder="E-Mail" autocomplete="email" style="border:1px solid #cbd5e1;border-radius:.5rem;padding:.6rem">
            <input id="sb-pass" type="password" required minlength="6" placeholder="Passwort" autocomplete="current-password" style="border:1px solid #cbd5e1;border-radius:.5rem;padding:.6rem">
            <button type="submit" style="background:#0f172a;color:#fff;border-radius:.5rem;padding:.6rem;font-weight:600">Anmelden</button>
            <button type="button" id="sb-signup" style="color:#0369a1;font-size:.875rem">Neues Konto erstellen</button>
            <p id="sb-msg" style="color:#b91c1c;font-size:.875rem;min-height:1.1rem"></p>
        </form>`;

    const logout = document.createElement('button');
    logout.textContent = 'Abmelden';
    logout.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9000;background:#0f172a;color:#fff;border-radius:.5rem;padding:.4rem .8rem;font-size:.8rem;display:none';
    logout.onclick = () => sb.auth.signOut();

    function setMsg(t) { overlay.querySelector('#sb-msg').textContent = t || ''; }

    let currentUser = undefined;
    async function onSession(session) {
        const uid = session ? session.user.id : null;
        if (uid === currentUser) return; // Token-Refresh o. ä. ignorieren
        currentUser = uid;
        if (session) {
            overlay.remove();
            logout.style.display = 'block';
            await loadContacts();
        } else {
            ready = false;
            logout.style.display = 'none';
            contacts = [];
            originalRender();
            document.body.appendChild(overlay);
        }
    }

    window.addEventListener('DOMContentLoaded', async () => {
        document.body.appendChild(logout);
        overlay.querySelector('#sb-login').addEventListener('submit', async (e) => {
            e.preventDefault();
            setMsg('');
            const { error } = await sb.auth.signInWithPassword({
                email: overlay.querySelector('#sb-email').value.trim(),
                password: overlay.querySelector('#sb-pass').value
            });
            if (error) setMsg('Anmeldung fehlgeschlagen: ' + error.message);
        });
        overlay.querySelector('#sb-signup').addEventListener('click', async () => {
            setMsg('');
            const { data, error } = await sb.auth.signUp({
                email: overlay.querySelector('#sb-email').value.trim(),
                password: overlay.querySelector('#sb-pass').value
            });
            if (error) setMsg('Registrierung fehlgeschlagen: ' + error.message);
            else if (!data.session) setMsg('Bitte bestätige die E-Mail und melde dich dann an.');
        });
        sb.auth.onAuthStateChange((_evt, session) => { onSession(session); });
    });
})();
