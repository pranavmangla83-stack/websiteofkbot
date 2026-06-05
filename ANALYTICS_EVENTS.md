# GA4 Analytics Events

Clean event tracking starts from June 5, 2026. Do not reuse old mixed event names for the payment-first flow.

## Active Events

| Event name | When it fires | Parameters | File/location |
| --- | --- | --- | --- |
| `payment_basic_click` | User clicks a Basic checkout CTA such as Start Basic on the homepage or pricing section. Guarded per clicked element to avoid double-click duplicates. | `plan_name: "basic"`, `price: CURRENT_BASIC_PRICE`, `currency: "INR"` | `assets/js/auth.js` in `trackPaymentBasicClickOnce()` called from `startAuthFlow()` |
| `demo_chat_open` | Homepage live demo section enters the visitor's viewport. | `source: "homepage_live_demo"` | `index.html` live demo script |
| `demo_url_submitted` | Visitor submits a website URL for the homepage live demo crawler. | `source: "homepage_live_demo"` | `index.html` live demo script |
| `demo_crawl_success` | Homepage live demo crawler indexes at least a response from the submitted website crawl endpoint. | `source: "homepage_live_demo"`, `indexed_pages` | `index.html` live demo script |
| `demo_crawl_failed` | Homepage live demo crawler request fails or the URL is rejected. | `source: "homepage_live_demo"` | `index.html` live demo script |
| `demo_question_sent` | Visitor sends a question in the homepage live demo. | `question_number`, `message_limit: 5` | `index.html` live demo script |
| `demo_limit_reached` | Visitor reaches the 5-message homepage live demo limit. Guarded once per browser. | `message_limit: 5` | `index.html` live demo script |
| `demo_start_basic_click` | Visitor clicks Start Basic after using/reaching the homepage live demo CTA. | `source: "homepage_live_demo"` | `index.html` live demo script |
| `customer_chat_message_sent` | Visitor sends a message through an installed customer chatbot widget. | `source: "customer"`, `demo: false` | `backend/src/widget/widget.js` |
| `customer_first_chat_message` | Visitor sends their first message through a specific installed customer chatbot widget on that browser. Guarded in localStorage. | `source: "customer"`, `demo: false` | `backend/src/widget/widget.js` |
| `pdf_upload_success` | Logged-in customer successfully uploads a PDF from the dashboard and the backend returns success. | `source: "customer"`, `demo: false` | `assets/js/auth.js` dashboard upload handler |
| `sign_up_complete` | Kinde authentication returns through the redirect callback, the user is authenticated, and `/api/auth/sync-user` succeeds. Guarded once per browser session/user. | `method: "kinde"` | `assets/js/auth.js` in `storeAuthCompleted()`, `consumeAuthCompleted()`, and `trackSignupCompleteOnce()` around `syncAuthenticatedUser()` |
| `payment_popup_open` | Razorpay checkout is successfully opened by `razorpay.open()`. It does not fire when subscription creation starts or when opening fails. | `plan_name: "basic"`, `price: CURRENT_BASIC_PRICE`, `currency: "INR"`, `payment_provider: "razorpay"` | `assets/js/auth.js` in `trackPaymentPopupOpen()` called from `openRazorpayCheckout()` |
| `purchase` | Backend payment verification succeeds through `/api/billing/verify-checkout` after Razorpay returns a payment response. | `transaction_id`, `plan_name: "basic"`, `value: CURRENT_BASIC_PRICE`, `currency: "INR"`, `payment_provider: "razorpay"` | `assets/js/auth.js` in `pushPurchaseEvent()` after successful verification |

## Shared Config

`CURRENT_BASIC_PRICE` is defined in `assets/js/plan-config.js`.

Current value:

```js
export const CURRENT_BASIC_PRICE = 1;
```

Change this one value to `250` later when Basic pricing is changed.

## Old Events Removed

The app should no longer fire these old or mixed events:

- `pay_250_click`
- `pay_350_click`
- `pay_1_click`
- `start_basic_click`
- `demo_button`
- `book_demo_click`
- `begin_checkout`

`begin_checkout` is intentionally not used for now because historical GA4 data is mixed.
