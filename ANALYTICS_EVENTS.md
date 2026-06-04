# GA4 Analytics Events

Clean event tracking starts from June 5, 2026. Do not reuse old mixed event names for the payment-first flow.

## Active Events

| Event name | When it fires | Parameters | File/location |
| --- | --- | --- | --- |
| `payment_basic_click` | User clicks a Basic checkout CTA such as Start Basic on the homepage or pricing section. Guarded per clicked element to avoid double-click duplicates. | `plan_name: "basic"`, `price: CURRENT_BASIC_PRICE`, `currency: "INR"` | `assets/js/auth.js` in `trackPaymentBasicClickOnce()` called from `startAuthFlow()` |
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
