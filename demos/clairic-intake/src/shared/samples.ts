import type { InboxDoc } from "./types";
import type { PresetId } from "./presets";

export type Sample = {
  id: string;
  title: string;
  preset: PresetId;
  state: string;
  image?: "receipt";
};

export const INVOICE_STATE =
  "Invoice INV-2291 from Northwind Supply, issued 2026-09-02, net 30. 4 pallets at $250.00 each, shipping $80.00. Contact: Dana Ruiz, Priya Shah.";

export const SUPPORT_STATE =
  "Hi, order A-88412 arrived on 2026-09-28 with a cracked screen and a dented corner. I paid $649.00 plus $52.10 tax. It's now 2026-10-09 and I'd like this fixed or refunded. Thanks, Dana Ruiz";

export const INSURANCE_STATE = `Claimant: Morgan Lee. Policy POL-44190. Incident date 2026-08-14. Vehicle damage and a sprained wrist. No police report number was given. Loss listed as $4200.00.
Weekly payout history, dollars:
2026-09-07, 800
2026-09-14, 760
2026-09-21, 740
2026-09-28, 710
2026-10-05, 690`;

export const RECEIPT_STATE = `NORTHWIND CAFE
Order 77245
2026-07-01 13:34
2 x drip coffee $7.99
Subtotal $15.98
Tax $0.00
Tip $2.39
Total $18.37`;

export const SAMPLES: Sample[] = [
  { id: "support", title: "Support email", preset: "support", state: SUPPORT_STATE },
  { id: "invoice", title: "Invoice", preset: "invoice", state: INVOICE_STATE },
  { id: "insurance", title: "Insurance claim", preset: "insurance", state: INSURANCE_STATE },
  { id: "receipt", title: "Receipt photo", preset: "invoice", state: RECEIPT_STATE, image: "receipt" },
  {
    id: "unclear",
    title: "Unclear note",
    preset: "support",
    state: "Hi, I think the order was A- maybe 19, and the charge was around forty dollars. Not sure of the date. Thanks, Sam",
  },
];

export const INBOX: InboxDoc[] = [
  { id: "in-01", title: "Northwind pallets", preset: "invoice", state: INVOICE_STATE },
  {
    id: "in-02",
    title: "Harbor linen, with PO",
    preset: "invoice",
    state: "Invoice INV-4402 from Harbor Linen, issued 2026-10-01, net 15. PO-100. 2 crates at $80.00 each, shipping $20.00. Contact: Luis Ortega.",
  },
  {
    id: "in-03",
    title: "Invoice missing a number",
    preset: "invoice",
    state: "From Bright Office, issued 2026-07-11, net 30. Shipping $15.00. No purchase order on the page. Contact: Priya Shah.",
  },
  { id: "sup-01", title: "Cracked screen", preset: "support", state: SUPPORT_STATE },
  {
    id: "sup-02",
    title: "Where is my tracking",
    preset: "support",
    state: "Hello, order B-22019 arrived on 2026-10-01. I paid $120.00. It is now 2026-10-08. The box was fine. Thanks, Noah Patel",
  },
  {
    id: "sup-03",
    title: "Unclear refund",
    preset: "support",
    state: "Hi, I think the order was A- maybe 19, and the charge was around forty dollars. Not sure of the date. Thanks, Sam",
  },
  {
    id: "sup-04",
    title: "Dented parcel",
    preset: "support",
    state: "Order C-77 showed up on 2026-09-02 with a dented corner. Paid $40.00 plus $3.20 tax. Writing on 2026-09-20. Thanks, Mina Cho",
  },
  { id: "clm-01", title: "Morgan Lee auto", preset: "insurance", state: INSURANCE_STATE },
  {
    id: "clm-02",
    title: "Kitchen leak",
    preset: "insurance",
    state: `Claimant: Avery Chen. Policy POL-22011. Incident date 2026-09-03. Water leak. Police report PR-88. Loss listed as $900.00.
Weekly payout history, dollars:
2026-09-08, 200
2026-09-15, 180
2026-09-22, 160`,
  },
  {
    id: "clm-03",
    title: "Claim without a report",
    preset: "insurance",
    state: "Claimant: Riley Quinn. Policy POL-9. Incident date 2026-06-02. Broken hinge. No police report number was given. Loss listed as $250.00.",
  },
  {
    id: "in-04",
    title: "Cafe receipt transcript",
    preset: "invoice",
    state: "Invoice INV-77245 from Northwind Cafe, issued 2026-07-01, net 7. 2 drinks at $7.99 each, shipping $0.00. Contact: Dana Ruiz.",
  },
  {
    id: "sup-05",
    title: "Hinge on a lamp",
    preset: "support",
    state: "Hi, order D-15 arrived on 2026-10-02 with a broken hinge. I paid $89.50 plus $7.16 tax. Today is 2026-10-12. Thanks, Elena Voss",
  },
];

export function bundledInbox(): InboxDoc[] {
  return INBOX.map((doc) => ({ ...doc }));
}
