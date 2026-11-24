# Lemon Squeezy PayPal subscriber check (CLI)

Lemon Squeezy stops processing payments, including renewals, on **March 31, 2027**. Card subscriptions can be migrated, but **PayPal subscriptions cannot**: every PayPal subscriber has to buy a new subscription.

From December 2, 2026, Lemon Squeezy's Migration Hub flags the customers who need to act. This script adds what you need to plan around them: the **monthly revenue at stake**, which **plans** they are on, and the **week each subscriber's paid period ends**. It can also export those subscribers to a file for a re-subscription campaign.

- One file, unminified, **no dependencies**. Read it before you run it.
- Talks **only** to `https://api.lemonsqueezy.com`, plus `https://api.stripe.com` (read-only, your restricted key) when `cancel` verifies new subscriptions. Never contacts any other server, ours included.
- Never writes your API keys to disk.
- Node.js 18 or later.

## Run it

1. In Lemon Squeezy, go to **Settings → API** and create a new **live-mode** key. Lemon Squeezy keys are full-access, so create one just for this and delete it when you are done.
2. Run the check:

```sh
node lemon-squeezy-paypal-check.mjs
```

Paste the key at the hidden prompt, or set it first:

```sh
LEMONSQUEEZY_API_KEY=... node lemon-squeezy-paypal-check.mjs
```

```powershell
$env:LEMONSQUEEZY_API_KEY = "..."; node lemon-squeezy-paypal-check.mjs
```

## Commands

| Command | What it does |
|---|---|
| `check` (default) | Prints the report. `--json` for machine-readable output. Nothing leaves your machine. |
| `export --out stranded.json` | Writes the stranded subscribers of one store to a file (readable only by you) that you upload to your campaign. Add `--store <id>` if your key sees more than one store. |
| `cancel cancel-list.json` | Cancels the old Lemon Squeezy subscriptions of customers who re-subscribed, from the cancel list your campaign dashboard gives you. Writes `cancel-results.json` to upload back. |

The export contains customer names and emails, plan, price and renewal dates for subscribers who must re-subscribe (plus paused or unpaid PayPal subscriptions, flagged for review). It never contains your API key or test-mode subscriptions. Upload it only in your campaign.

## Cancelling old subscriptions

After a customer re-subscribes, their old Lemon Squeezy subscription must be cancelled before its renewal date, or they are charged twice. Download `cancel-list.json` from the campaign dashboard, then:

```sh
LEMONSQUEEZY_API_KEY=... STRIPE_API_KEY=rk_... node lemon-squeezy-paypal-check.mjs cancel cancel-list.json
```

Before anything is cancelled, each item is read again from Lemon Squeezy and skipped if it is missing, already cancelled, not PayPal-processed, or its email differs from the list. With `STRIPE_API_KEY` (a **restricted** key; secret keys are refused) it also checks that the customer's new Stripe subscription exists, is active or trialing, and belongs to that old subscription. Without it the command stops unless you pass `--no-verify`. You confirm the final list (or pass `--yes`). After each cancel the subscription is read again: it only counts as cancelled if Lemon Squeezy shows it cancelled.

If an old subscription renewed after the customer switched, the results mark it as an overlap: refund that Lemon Squeezy payment.

## What the report shows

Per store:

- **PayPal subscribers who must re-subscribe**: `payment_processor` is `paypal`, not cancelled, and status `active`, `on_trial` or `past_due`.
- **Monthly revenue at stake**: list price, in store currency, before discounts and tax. Yearly, weekly and daily plans are converted to a monthly figure. Usage-based and tiered prices are counted separately, not guessed.
- **By plan**, and **by the week each subscriber's paid period ends**, up to the cutoff.
- How many are **already paid through beyond the cutoff**.
- **Needs a look**, listed separately and not in the headline number: paused or unpaid PayPal subscriptions, and Stripe-processed subscriptions paid without a card (only relevant if you are leaving Stripe).

Test-mode subscriptions are ignored. If the key only sees test-mode data, the script says so.

## Verify the file

Every release publishes the file's SHA-256 here and on the website. Compare before running:

```sh
shasum -a 256 lemon-squeezy-paypal-check.mjs
```

```powershell
Get-FileHash lemon-squeezy-paypal-check.mjs -Algorithm SHA256
```

## Exit codes

`0` success · `1` error (for `cancel`: at least one item failed) · `2` bad usage, rejected key, or test-mode key · `130` cancelled.

## Licence

MIT. See `LICENSE`.

Not affiliated with Lemon Squeezy, Stripe, or PayPal.

## This repository

- `lemon-squeezy-paypal-check.mjs`: the released file (v0.3.0). `SHA256SUMS` holds its hash.
- `cli/src/main.ts` and `src/`: every source file it is built from, nothing else.
- Rebuild it and compare the hash (esbuild 0.28.2, pinned):

```sh
npm ci
npm run build
shasum -a 256 cli/dist/lemon-squeezy-paypal-check.mjs   # must equal SHA256SUMS
```

The file talks only to `https://api.lemonsqueezy.com`. The build fails if the bundle would import any npm package or name another host (the one exception is the campaign website, which the `export` command prints and never contacts).
