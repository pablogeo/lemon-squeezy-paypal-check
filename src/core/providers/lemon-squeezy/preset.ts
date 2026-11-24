// Lemon Squeezy preset: cutoff, disclaimers, default email templates, landing copy.
// Copy must stay factual (BRIEF 5.7, 7). The brand name is always interpolated from config.
import { BRAND_NAME } from '@/config/brand';
import type { ProviderPreset } from '../types';

/** LS has not published an hour; this is deliberately the early edge of the day. */
export const LEMON_SQUEEZY_CUTOFF = new Date('2027-03-31T00:00:00Z');

export const lemonSqueezyPreset: ProviderPreset = {
  displayName: 'Lemon Squeezy',
  cutoffAt: LEMON_SQUEEZY_CUTOFF,
  disclaimers: ['Not affiliated with Lemon Squeezy, Stripe, or PayPal.'],

  // Merge tags: {{customer_name}} {{product_name}} {{variant_name}} {{renews_at_formatted}}
  // {{cutoff_date_formatted}} {{resub_url}} {{store_name}} {{support_email}}.
  // Milestone 3 adds the per-subscriber "no charge today" line (only when true) and, in
  // stripe_managed mode, the line saying checkout and receipts come from Link.
  defaultEmailTemplates: [
    {
      step: 1,
      subject: 'Action needed to keep your {{product_name}} subscription',
      bodyMarkdown: [
        'Hi {{customer_name}},',
        '',
        'You pay for {{product_name}} ({{variant_name}}) with PayPal through Lemon Squeezy. Lemon Squeezy stops processing payments on {{cutoff_date_formatted}}, and PayPal subscriptions cannot be moved to the new payment system. Without a new subscription, your plan will not renew after that date.',
        '',
        'This personal link keeps your plan and your renewal date:',
        '',
        '{{resub_url}}',
        '',
        'It takes about a minute. Your next payment stays on {{renews_at_formatted}}, the same day as now.',
        '',
        'Questions? Reply to this email or write to {{support_email}}.',
        '',
        '{{store_name}}',
      ].join('\n'),
    },
    {
      step: 2,
      subject: 'Reminder: your {{product_name}} subscription needs a new payment method',
      bodyMarkdown: [
        'Hi {{customer_name}},',
        '',
        'A quick reminder: PayPal billing for {{product_name}} through Lemon Squeezy ends on {{cutoff_date_formatted}}.',
        '',
        'Your personal link keeps your plan and renewal date: {{resub_url}}',
        '',
        'Questions? Write to {{support_email}}.',
        '',
        '{{store_name}}',
      ].join('\n'),
    },
    {
      step: 3,
      subject: 'Last notice: PayPal billing for {{product_name}} ends {{cutoff_date_formatted}}',
      bodyMarkdown: [
        'Hi {{customer_name}},',
        '',
        'This is the last reminder. PayPal billing for {{product_name}} through Lemon Squeezy ends on {{cutoff_date_formatted}}. After that, your subscription will not renew.',
        '',
        'Keep your plan and renewal date here: {{resub_url}}',
        '',
        'Questions? Write to {{support_email}}.',
        '',
        '{{store_name}}',
      ].join('\n'),
    },
  ],

  landingCopy: {
    heroEyebrow: 'For Lemon Squeezy sellers',
    heroTitle: 'Keep the revenue from your PayPal subscribers.',
    heroBody:
      "Lemon Squeezy stops processing payments, including renewals, on March 31, 2027, and PayPal subscriptions cannot be migrated: each PayPal subscriber has to buy a new subscription. From December 2, Lemon Squeezy's Migration Hub flags the customers who need to act. This check shows what is at stake: the monthly revenue, which plans, and the week each subscriber's paid period ends, so you know how much time you have and what to do next.",
    checkerTitle: 'See the revenue at stake',
    checkerBody:
      'Monthly revenue on PayPal subscriptions, broken down by plan, and the week each subscriber renews, up to the cutoff.',
    cliTitle: 'Run it on your own machine (recommended)',
    cliBody:
      'One file, no dependencies, readable source. It talks only to api.lemonsqueezy.com and prints the report in your terminal.',
    cliKeyLine: 'Your API key never leaves your machine.',
    pasteTitle: 'Or paste a key here',
    keySecurity:
      'Lemon Squeezy API keys are full-access. If you paste one here we use it for this one scan and do not store it. Create a dedicated key and delete it afterwards, or use the CLI so it never leaves your machine.',
    keyHowTo: 'Create a key in Lemon Squeezy under Settings → API. Use a live-mode key: test-mode keys only see test data.',
    runDisclosure: `Each scan on this page records one anonymous counter row: the time, whether it was a demo, a rounded range of stranded subscribers and revenue, and your answer to the destination question if you give one. No key, store ID, email address or IP address is stored. CLI runs are not counted: the CLI never contacts us.`,
    howTitle: `How a ${BRAND_NAME} campaign works`,
    how1Title: 'A personal link per subscriber',
    how1Body:
      'Each PayPal subscriber gets a link that opens a short confirmation page in your name, then a Stripe Checkout whose first charge is set to the date they have already paid through.',
    how2Title: 'Three short emails, from your own email account',
    how2Body:
      'A launch email, a reminder a week later, and a final notice about two weeks before the cutoff, sent through your own Resend account. People who have already switched are never emailed again.',
    how3Title: 'No double charges',
    how3Body:
      'Each subscriber who re-subscribes gets a "cancel by" date: their old Lemon Squeezy renewal. Old subscriptions are cancelled with one command you run locally, or automatically if you choose to connect your key.',
    localTitle: 'Your Lemon Squeezy key stays with you',
    localBody:
      "By default you never give us your Lemon Squeezy key. You export your PayPal subscribers with the CLI and upload the file; before each customer's old renewal you run one command that cancels the subscriptions of customers who have already switched. You can choose to connect your key instead, and the server then does both for you.",
    customerPromise: 'Keep your plan, keep your renewal date, pay nothing extra.',
    destinationNote:
      'Paid campaigns currently support sellers moving to Stripe (Managed Payments or a standard Stripe account). Moving somewhere else? Leave your email after the scan and we will tell you when your provider is supported.',
    smallStoreAdvice:
      'With fewer than 5 PayPal subscribers, a paid campaign is probably not worth it. Email them yourself; here is a template you can copy.',
    copyEmailSubject: 'Your subscription needs a new payment method before March 31, 2027',
    copyEmailBody: [
      'Hi,',
      '',
      'You pay for your subscription with PayPal through Lemon Squeezy, our payment provider. Lemon Squeezy stops processing payments on March 31, 2027, and PayPal subscriptions cannot be moved to our new payment system, so your subscription will not renew after that date.',
      '',
      'To keep your plan, please subscribe again here before your next renewal: [YOUR NEW CHECKOUT LINK]',
      '',
      'Once your new subscription is active, I will cancel the old one so you are not charged twice.',
      '',
      'Thanks,',
      '[YOUR NAME]',
    ].join('\n'),
  },
};
