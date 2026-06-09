# Deploy su Render Free + Supabase Free

Questa app Shopify usa Supabase Postgres per salvare le sessioni OAuth e Render per servire l'interfaccia embedded nell'admin Shopify.

## 1. Supabase

1. Crea un progetto su Supabase.
2. Vai in **Project Settings > Database**.
3. Copia due connection string:
   - **Transaction pooler** per `DATABASE_URL`
   - **Session pooler** per `DIRECT_URL`
4. Sostituisci `[PASSWORD]` con la password database del progetto.

Esempio:

```env
DATABASE_URL=postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
DIRECT_URL=postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
```

Su Render non usare `db.[PROJECT_REF].supabase.co:5432` per `DIRECT_URL`, a meno che il progetto Supabase abbia l'IPv4 add-on o l'ambiente supporti IPv6. La direct connection Supabase puo' risolvere solo in IPv6; il pooler condiviso Supavisor e' compatibile IPv4.

## 2. Render

1. Pubblica questo progetto su GitHub.
2. In Render scegli **New > Blueprint** e collega il repository.
3. Render leggerà `render.yaml` e creerà il web service free.
4. Inserisci queste variabili ambiente:

```env
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SCOPES=read_cart_transforms,write_cart_transforms,write_metaobject_definitions,read_products,write_products
SHOPIFY_APP_URL=https://custom-sqm-pricing-wowstampa.onrender.com
DATABASE_URL=
DIRECT_URL=
```

Se Render assegna un dominio diverso da `https://custom-sqm-pricing-wowstampa.onrender.com`, usa il dominio effettivo in `SHOPIFY_APP_URL`.

## 3. Shopify

Il dominio Render deve combaciare con `shopify.app.toml`:

```toml
application_url = "https://custom-sqm-pricing-wowstampa.onrender.com"

[auth]
redirect_urls = [
  "https://custom-sqm-pricing-wowstampa.onrender.com/auth/callback",
  "https://custom-sqm-pricing-wowstampa.onrender.com/auth/shopify/callback",
  "https://custom-sqm-pricing-wowstampa.onrender.com/api/auth/callback"
]
```

Se il dominio Render è diverso, aggiorna `shopify.app.toml` e poi esegui:

```bash
shopify app deploy
```

## 4. Note sul piano free

Render Free va in sleep dopo un periodo di inattività. Quando riapri l'app da Shopify Admin, il primo caricamento può richiedere circa un minuto.
