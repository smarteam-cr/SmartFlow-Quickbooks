const { formatToQbDate } = require('../../utils/date.util');

const mapLineItemToQb = (hsItem, qbItemId, taxCodeId) => {
  const price = Number(hsItem.properties.price || 0);
  const qty = Number(hsItem.properties.quantity || 1);

  // HubSpot 'amount' ya incluye el descuento por línea aplicado.
  // Si no viene (compatibilidad), fallback a price × qty.
  const lineAmount = hsItem.properties.amount
    ? Number(hsItem.properties.amount)
    : price * qty;

  // QB valida que Amount = UnitPrice × Qty internamente.
  // Calculamos un precio unitario efectivo para que los números cuadren.
  const effectiveUnitPrice = qty > 0 ? lineAmount / qty : price;

  return {
    Amount: lineAmount,
    Description: hsItem.properties.description || hsItem.properties.name,
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      ItemRef: { value: qbItemId.toString() },
      UnitPrice: effectiveUnitPrice,
      Qty: qty,
      TaxCodeRef: { value: taxCodeId.toString() }
    },
  };
};

const mapInvoicePayload = (hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo, utcOffsetMs = 0, qbCustomer = null, qbPreferences = null) => {
  const payload = {
    CustomerRef: { value: qbCustomerId.toString() },
    // QB calcula TxnTaxDetail automáticamente a partir de los TaxCodeRef de cada línea.
    GlobalTaxCalculation: "TaxExcluded",
    Line: qbInvoiceLines,
    TxnDate: formatToQbDate(hsInvoice.properties.hs_invoice_date, utcOffsetMs),
    DueDate: formatToQbDate(hsInvoice.properties.hs_due_date, utcOffsetMs),
    CustomerMemo: {
      value: hsInvoice.properties.hs_title || `Factura exportada desde HubSpot`
    }
  };

  if (contactInfo) {
    const { displayName, address, city, state, zip, country } = contactInfo;
    const addressParts = [address, city, state, zip, country].filter(part => !!part);
    payload.BillAddr = { Line1: displayName, Line2: addressParts.join(', ') };
  }

  if (qbCustomer) {
    // CurrencyRef debe heredarse SIEMPRE del customer. Si no lo seteamos, QB
    // asume la home currency del realm; cuando el customer está en una moneda
    // distinta a la home (multi-currency activado), QB rechaza con
    // "You can only use one foreign currency per transaction" (code=6000).
    // Aunque el realm sea single-currency, mandar CurrencyRef explícito es
    // idempotente y evita futuros bugs si el cliente activa multi-currency.
    if (qbCustomer.CurrencyRef?.value) {
      payload.CurrencyRef = { value: qbCustomer.CurrencyRef.value };
    }
    if (qbCustomer.SalesTermRef?.value) {
      payload.SalesTermRef = { value: qbCustomer.SalesTermRef.value };
    }
    if (qbCustomer.PaymentMethodRef?.value) {
      payload.PaymentMethodRef = { value: qbCustomer.PaymentMethodRef.value };
    }
    if (qbCustomer.PrimaryEmailAddr?.Address) {
      payload.BillEmail = { Address: qbCustomer.PrimaryEmailAddr.Address };
    }
  }

  if (qbPreferences) {
    const salesPrefs = qbPreferences.SalesFormsPrefs || {};
    // Fallback: si el customer no tiene SalesTermRef, usar el default de la empresa.
    if (!payload.SalesTermRef && salesPrefs.DefaultTerms?.value) {
      payload.SalesTermRef = { value: salesPrefs.DefaultTerms.value };
    }
    if (salesPrefs.SalesEmailCc?.Address) {
      payload.BillEmailCc = { Address: salesPrefs.SalesEmailCc.Address };
    }
    if (salesPrefs.SalesEmailBcc?.Address) {
      payload.BillEmailBcc = { Address: salesPrefs.SalesEmailBcc.Address };
    }
  }

  return payload;
};

module.exports = { mapLineItemToQb, mapInvoicePayload };
