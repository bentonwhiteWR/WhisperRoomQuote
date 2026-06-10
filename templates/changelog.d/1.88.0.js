module.exports = {
  v: '1.88.0', date: 'June 10, 2026', tag: 'feature',
  changes: [
    { t: 'add', d: '<b>Component Inventory is now in the app — new Inventory page in the nav.</b> The Excel Inventory sheet (on-hand per component code, build points, build/finished/in-process quantities) now lives here, seeded from the current PackingList.xlsm numbers. Edit any cell and Save — only the changed rows are written, and each on-hand change is recorded as an audited adjustment with who/when, so two people working the same day can no longer wipe each other&apos;s edits.' },
    { t: 'add', d: '<b>Shipping an order now deducts inventory automatically.</b> When an order is marked Shipped (Ship It on the Orders board, or the shipping-board Add Shipment), the generated packing list&apos;s components are deducted from on-hand in one transaction — same as the Excel macro, including the F12/F07 to F01 vent-set remap — and un-shipping restores exactly what was deducted. A re-save of a shipped order can never double-deduct. Unknown codes are no longer silently skipped: they appear as new rows going negative, so nothing slips through uncounted.' },
    { t: 'add', d: '<b>Needed-for-orders demand, live.</b> The grid shows how many of each component the open (unshipped) orders need, plus Available (on hand minus needed), with Low / Not Enough / Negative flags — replacing the Excel COUNTIF columns.' },
    { t: 'add', d: '<b>Sync from Excel for the parallel run.</b> Paste the Inventory sheet (columns B–K) into the Sync dialog to re-align the app to Excel anytime while both systems run side by side; differences apply as audited sync adjustments and new codes are created automatically.' },
  ],
};
