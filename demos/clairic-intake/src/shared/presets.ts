import type { FieldSpec } from "./types";

export type PresetId = "invoice" | "support" | "insurance";

export const PRESETS: Record<PresetId, { label: string; fields: Record<string, FieldSpec> }> = {
  invoice: {
    label: "Invoice",
    fields: {
      vendor: { type: "text", instructions: "Company that issued the invoice" },
      invoice_number: { type: "text", instructions: "Invoice number" },
      issued: { type: "date", instructions: "Issue date" },
      due_date: { type: "date", instructions: "Issue date plus the net payment days" },
      total: { type: "number", decimals: 2, unit: "USD", instructions: "Amount due including shipping" },
      contacts: { type: "list", items: "text", instructions: "People named as contacts" },
      po_number: { type: "text", instructions: "Purchase order number" },
      days_to_pay: {
        type: "estimate",
        min: 0,
        max: 120,
        step: 1,
        unit: "days",
        instructions: "Days after issue until this invoice is paid",
      },
    },
  },
  support: {
    label: "Support ticket",
    fields: {
      customer_name: { type: "text", instructions: "Customer's name" },
      order_id: { type: "text", instructions: "Order number" },
      delivered_on: { type: "date", instructions: "Delivery date" },
      amount_paid: { type: "number", decimals: 2, unit: "USD", instructions: "Total paid including tax" },
      days_since_delivery: {
        type: "duration",
        unit: "days",
        integer: true,
        instructions: "Days from delivery to the date the customer wrote",
      },
      damage: { type: "list", items: "text", instructions: "Each kind of damage described" },
      tracking_number: { type: "text", instructions: "Carrier tracking number" },
      repair_cost: {
        type: "estimate",
        unit: "USD",
        min: 10,
        max: 5000,
        scale: "log",
        step: 1,
        instructions: "Cost to repair the damage described",
      },
    },
  },
  insurance: {
    label: "Insurance claim",
    fields: {
      claimant: { type: "text", instructions: "Person filing the claim" },
      policy_number: { type: "text", instructions: "Policy number" },
      incident_date: { type: "date", instructions: "Date of the incident" },
      loss_amount: { type: "number", decimals: 2, unit: "USD", instructions: "Listed loss amount" },
      injuries: { type: "list", items: "text", instructions: "Each injury or damage described" },
      police_report: { type: "text", instructions: "Police report number" },
      reserve: {
        type: "estimate",
        unit: "USD",
        min: 100,
        max: 50000,
        scale: "log",
        step: 1,
        instructions: "Reserve to hold for this claim",
      },
      weekly_payout: {
        type: "forecast",
        unit: "USD",
        min: 0,
        max: 20000,
        horizon: 4,
        interval: "week",
        instructions: "Payout dollars for each of the next four weeks, from the history in the note",
      },
    },
  },
};

export function cloneFields(fields: Record<string, FieldSpec>): Record<string, FieldSpec> {
  return JSON.parse(JSON.stringify(fields)) as Record<string, FieldSpec>;
}
