create table if not exists public.kismart_records (
  type text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (type, id)
);

create index if not exists kismart_records_type_updated_at_idx
  on public.kismart_records (type, updated_at desc);

alter table public.kismart_records disable row level security;
