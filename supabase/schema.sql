-- Im Supabase Dashboard unter SQL Editor einfügen und ausführen.
create table if not exists public.contacts (
    id text primary key,
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    first_name text default '',
    last_name text default '',
    organization text default '',
    trade text default '',
    scope_of_services text default '',
    status text default 'NEU',
    title text default '',
    email text default '',
    phone text default '',
    website text default '',
    address text default '',
    notes text default '',
    created_at_label text default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists contacts_user_idx on public.contacts (user_id, created_at desc);

alter table public.contacts enable row level security;

-- Jeder Nutzer sieht und ändert nur seine eigenen Kontakte
create policy "contacts_select_own" on public.contacts
    for select using (auth.uid() = user_id);
create policy "contacts_insert_own" on public.contacts
    for insert with check (auth.uid() = user_id);
create policy "contacts_update_own" on public.contacts
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "contacts_delete_own" on public.contacts
    for delete using (auth.uid() = user_id);
