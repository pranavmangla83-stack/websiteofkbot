CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.current_kinde_user_id()
RETURNS text AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('app.kinde_user_id', true), '')
  );
$$ LANGUAGE sql STABLE;

CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kinde_user_id text NOT NULL UNIQUE,
  email text,
  full_name text,
  company_name text,
  current_plan text NOT NULL DEFAULT 'free',
  chatbot_limit integer NOT NULL DEFAULT 1 CHECK (chatbot_limit >= 0),
  pdf_limit integer NOT NULL DEFAULT 3 CHECK (pdf_limit >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  kinde_user_id text NOT NULL UNIQUE,
  email text,
  full_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS full_name text;

CREATE TABLE IF NOT EXISTS public.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  display_name text NOT NULL,
  price_inr integer NOT NULL CHECK (price_inr >= 0),
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly', 'yearly')),
  chatbot_limit integer NOT NULL DEFAULT 1 CHECK (chatbot_limit >= 0),
  pdf_limit integer NOT NULL DEFAULT 3 CHECK (pdf_limit >= 0),
  message_limit integer NOT NULL DEFAULT 400 CHECK (message_limit >= 0),
  token_limit integer NOT NULL DEFAULT 1000000 CHECK (token_limit >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  plan_name text NOT NULL DEFAULT 'Basic',
  status text NOT NULL DEFAULT 'created',
  start_date timestamptz,
  end_date timestamptz,
  razorpay_customer_id text,
  razorpay_subscription_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  razorpay_payment_id text NOT NULL UNIQUE,
  razorpay_subscription_id text,
  amount integer NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL,
  raw_payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.chatbots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  chatbot_name text NOT NULL DEFAULT 'AI Assistant',
  website_url text,
  theme_settings jsonb NOT NULL DEFAULT jsonb_build_object(
    'primaryColor', '#0f1720',
    'accentColor', '#c96f4a',
    'position', 'bottom-right',
    'welcomeMessage', 'Hi!',
    'fallbackMessage', 'I do not have that information yet. Please contact the business directly.'
  ),
  public_embed_key text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(18), 'hex'),
  embed_script text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.chatbots ADD COLUMN IF NOT EXISTS website_url text;
ALTER TABLE public.chatbots ADD COLUMN IF NOT EXISTS public_embed_key text;
ALTER TABLE public.chatbots ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

UPDATE public.chatbots
SET public_embed_key = encode(gen_random_bytes(18), 'hex')
WHERE public_embed_key IS NULL;

ALTER TABLE public.chatbots ALTER COLUMN public_embed_key SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  chatbot_id uuid NOT NULL REFERENCES public.chatbots(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_size bigint NOT NULL CHECK (file_size >= 0),
  storage_path text NOT NULL UNIQUE,
  mime_type text NOT NULL DEFAULT 'application/pdf',
  page_count integer,
  checksum text,
  status text NOT NULL DEFAULT 'uploading_pdf'
    CHECK (status IN (
      'uploading_pdf',
      'extracting_pdf_text',
      'scanned_pdf_detected',
      'running_ocr',
      'creating_chunks',
      'saving_knowledge_base',
      'completed',
      'failed'
    )),
  source_type text CHECK (source_type IN ('pdf_text', 'ocr')),
  ocr_confidence numeric,
  error_message text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'uploading_pdf';
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS source_type text CHECK (source_type IN ('pdf_text', 'ocr'));
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS ocr_confidence numeric;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.documents ALTER COLUMN status SET DEFAULT 'uploading_pdf';
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_status_check;
UPDATE public.documents
SET status = CASE status
  WHEN 'uploaded' THEN 'uploading_pdf'
  WHEN 'processing' THEN 'extracting_pdf_text'
  WHEN 'ready' THEN 'completed'
  ELSE status
END
WHERE status IN ('uploaded', 'processing', 'ready');
ALTER TABLE public.documents ADD CONSTRAINT documents_status_check
  CHECK (status IN (
    'uploading_pdf',
    'extracting_pdf_text',
    'scanned_pdf_detected',
    'running_ocr',
    'creating_chunks',
    'saving_knowledge_base',
    'completed',
    'failed'
  ));

CREATE TABLE IF NOT EXISTS public.document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  chatbot_id uuid NOT NULL REFERENCES public.chatbots(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  chunk_text text NOT NULL,
  embedding vector(1536),
  token_count integer DEFAULT 0 CHECK (token_count >= 0),
  page_number integer CHECK (page_number IS NULL OR page_number >= 1),
  source_type text CHECK (source_type IN ('pdf_text', 'ocr', 'website')),
  ocr_confidence numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS page_number integer CHECK (page_number IS NULL OR page_number >= 1);
ALTER TABLE public.document_chunks DROP CONSTRAINT IF EXISTS document_chunks_source_type_check;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE public.document_chunks ADD CONSTRAINT document_chunks_source_type_check CHECK (source_type IN ('pdf_text', 'ocr', 'website'));
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS ocr_confidence numeric;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.document_chunks ALTER COLUMN document_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.website_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  chatbot_id uuid NOT NULL REFERENCES public.chatbots(id) ON DELETE CASCADE,
  url text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'indexed'
    CHECK (status IN ('indexed', 'failed')),
  error_message text,
  content_hash text,
  indexed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, chatbot_id, url)
);

CREATE TABLE IF NOT EXISTS public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  chatbot_id uuid NOT NULL REFERENCES public.chatbots(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  visitor_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  chatbot_id uuid NOT NULL REFERENCES public.chatbots(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('user', 'bot', 'system')),
  message_text text NOT NULL,
  token_usage integer NOT NULL DEFAULT 0 CHECK (token_usage >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.chat_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  chatbot_id uuid NOT NULL REFERENCES public.chatbots(id) ON DELETE CASCADE,
  chat_session_id uuid REFERENCES public.chat_sessions(id) ON DELETE SET NULL,
  visitor_id text,
  name text,
  email text,
  phone text,
  question text,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.usage_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  month date NOT NULL,
  pdf_uploaded_count integer NOT NULL DEFAULT 0 CHECK (pdf_uploaded_count >= 0),
  chatbot_messages_count integer NOT NULL DEFAULT 0 CHECK (chatbot_messages_count >= 0),
  token_used integer NOT NULL DEFAULT 0 CHECK (token_used >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, month)
);

CREATE INDEX IF NOT EXISTS clients_kinde_user_id_idx ON public.clients(kinde_user_id);
CREATE INDEX IF NOT EXISTS clients_email_idx ON public.clients(email);
CREATE INDEX IF NOT EXISTS users_kinde_user_id_idx ON public.users(kinde_user_id);
CREATE INDEX IF NOT EXISTS users_client_id_idx ON public.users(client_id);
CREATE INDEX IF NOT EXISTS subscriptions_client_id_idx ON public.subscriptions(client_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON public.subscriptions(status);
CREATE INDEX IF NOT EXISTS chatbots_client_id_idx ON public.chatbots(client_id);
CREATE INDEX IF NOT EXISTS chatbots_public_embed_key_idx ON public.chatbots(public_embed_key);
CREATE INDEX IF NOT EXISTS documents_client_chatbot_idx ON public.documents(client_id, chatbot_id);
CREATE INDEX IF NOT EXISTS documents_status_idx ON public.documents(status);
CREATE INDEX IF NOT EXISTS document_chunks_client_chatbot_idx ON public.document_chunks(client_id, chatbot_id);
CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx ON public.document_chunks(document_id);
CREATE INDEX IF NOT EXISTS website_pages_client_chatbot_idx ON public.website_pages(client_id, chatbot_id);
CREATE INDEX IF NOT EXISTS website_pages_status_idx ON public.website_pages(status);
CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw_idx
  ON public.document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chat_sessions_chatbot_id_idx ON public.chat_sessions(chatbot_id);
CREATE INDEX IF NOT EXISTS messages_session_id_idx ON public.messages(session_id);
CREATE INDEX IF NOT EXISTS messages_client_chatbot_created_idx ON public.messages(client_id, chatbot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_leads_client_created_idx ON public.chat_leads(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_tracking_client_month_idx ON public.usage_tracking(client_id, month);

DROP TRIGGER IF EXISTS clients_set_updated_at ON public.clients;
CREATE TRIGGER clients_set_updated_at
BEFORE UPDATE ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS users_set_updated_at ON public.users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS subscriptions_set_updated_at ON public.subscriptions;
CREATE TRIGGER subscriptions_set_updated_at
BEFORE UPDATE ON public.subscriptions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS chatbots_set_updated_at ON public.chatbots;
CREATE TRIGGER chatbots_set_updated_at
BEFORE UPDATE ON public.chatbots
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS documents_set_updated_at ON public.documents;
CREATE TRIGGER documents_set_updated_at
BEFORE UPDATE ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS website_pages_set_updated_at ON public.website_pages;
CREATE TRIGGER website_pages_set_updated_at
BEFORE UPDATE ON public.website_pages
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS usage_tracking_set_updated_at ON public.usage_tracking;
CREATE TRIGGER usage_tracking_set_updated_at
BEFORE UPDATE ON public.usage_tracking
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding vector(1536),
  match_client_id uuid,
  match_chatbot_id uuid,
  match_count integer DEFAULT 8,
  similarity_threshold double precision DEFAULT 0.72
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  chunk_text text,
  metadata jsonb,
  similarity double precision
)
LANGUAGE sql STABLE AS $$
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_text,
    dc.metadata,
    1 - (dc.embedding <=> query_embedding) AS similarity
  FROM public.document_chunks dc
  WHERE dc.client_id = match_client_id
    AND dc.chatbot_id = match_chatbot_id
    AND dc.embedding IS NOT NULL
    AND 1 - (dc.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
$$;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'client-pdfs',
      'client-pdfs',
      false,
      10485760,
      ARRAY['application/pdf']
    )
    ON CONFLICT (id) DO UPDATE SET
      public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
  END IF;
END $$;

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_tracking ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clients_own_rows ON public.clients;
CREATE POLICY clients_own_rows ON public.clients
FOR ALL
USING (kinde_user_id = public.current_kinde_user_id())
WITH CHECK (kinde_user_id = public.current_kinde_user_id());

DROP POLICY IF EXISTS users_own_rows ON public.users;
CREATE POLICY users_own_rows ON public.users
FOR ALL
USING (kinde_user_id = public.current_kinde_user_id())
WITH CHECK (kinde_user_id = public.current_kinde_user_id());

DROP POLICY IF EXISTS subscriptions_own_rows ON public.subscriptions;
CREATE POLICY subscriptions_own_rows ON public.subscriptions
FOR ALL
USING (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()))
WITH CHECK (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()));

DROP POLICY IF EXISTS payments_own_rows ON public.payments;
CREATE POLICY payments_own_rows ON public.payments
FOR SELECT
USING (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()));

DROP POLICY IF EXISTS chatbots_own_rows ON public.chatbots;
CREATE POLICY chatbots_own_rows ON public.chatbots
FOR ALL
USING (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()))
WITH CHECK (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()));

DROP POLICY IF EXISTS documents_own_rows ON public.documents;
CREATE POLICY documents_own_rows ON public.documents
FOR ALL
USING (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()))
WITH CHECK (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()));

DROP POLICY IF EXISTS document_chunks_own_rows ON public.document_chunks;
CREATE POLICY document_chunks_own_rows ON public.document_chunks
FOR ALL
USING (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()))
WITH CHECK (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()));

DROP POLICY IF EXISTS website_pages_own_rows ON public.website_pages;
CREATE POLICY website_pages_own_rows ON public.website_pages
FOR ALL
USING (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()))
WITH CHECK (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()));

DROP POLICY IF EXISTS chat_sessions_own_rows ON public.chat_sessions;
CREATE POLICY chat_sessions_own_rows ON public.chat_sessions
FOR SELECT
USING (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()));

DROP POLICY IF EXISTS messages_own_rows ON public.messages;
CREATE POLICY messages_own_rows ON public.messages
FOR SELECT
USING (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()));

DROP POLICY IF EXISTS chat_leads_own_rows ON public.chat_leads;
CREATE POLICY chat_leads_own_rows ON public.chat_leads
FOR SELECT
USING (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()));

DROP POLICY IF EXISTS usage_tracking_own_rows ON public.usage_tracking;
CREATE POLICY usage_tracking_own_rows ON public.usage_tracking
FOR SELECT
USING (client_id IN (SELECT id FROM public.clients WHERE kinde_user_id = public.current_kinde_user_id()));
