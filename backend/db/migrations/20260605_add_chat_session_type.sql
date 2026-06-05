ALTER TABLE public.chat_sessions
ADD COLUMN IF NOT EXISTS session_type text NOT NULL DEFAULT 'customer';

UPDATE public.chat_sessions
SET session_type = 'customer'
WHERE session_type IS NULL;

ALTER TABLE public.chat_sessions
DROP CONSTRAINT IF EXISTS chat_sessions_session_type_check;

ALTER TABLE public.chat_sessions
ADD CONSTRAINT chat_sessions_session_type_check
CHECK (session_type IN ('demo', 'customer'));

CREATE INDEX IF NOT EXISTS chat_sessions_session_type_started_idx
ON public.chat_sessions(session_type, started_at DESC);
