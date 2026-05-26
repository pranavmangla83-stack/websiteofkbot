INSERT INTO public.plans (
  name,
  display_name,
  price_inr,
  billing_interval,
  chatbot_limit,
  pdf_limit,
  message_limit,
  token_limit,
  is_active
)
VALUES
  ('basic', 'Basic', 1, 'monthly', 1, 3, 400, 1000000, true),
  ('pro', 'Pro', 2, 'monthly', 1, 5, 700, 1500000, true)
ON CONFLICT (name)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  price_inr = EXCLUDED.price_inr,
  billing_interval = EXCLUDED.billing_interval,
  chatbot_limit = EXCLUDED.chatbot_limit,
  pdf_limit = EXCLUDED.pdf_limit,
  message_limit = EXCLUDED.message_limit,
  token_limit = EXCLUDED.token_limit,
  is_active = EXCLUDED.is_active;
