const { formatToQbDate } = require('../../utils/date.util');
const config = require('../../config');

const mapLineItemToQb = (hsItem, qbItemId) => {
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

  const isTaxable = hsItem.properties.es_gravable === "true" || !!hsItem.properties.hs_tax_rate_group_id;

  return {
    Amount: lineAmount,
    Description: hsItem.properties.description || hsItem.properties.name,
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      ItemRef: { value: qbItemId.toString() },
      UnitPrice: effectiveUnitPrice,
      Qty: qty,
      TaxCodeRef: { value: isTaxable ? "TAX" : "NON" }
    },
  };
};

const mapInvoicePayload = (hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo, utcOffsetMs = 0) => {
  const payload = {
    CustomerRef: { value: qbCustomerId.toString() },
    Line: [],
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

  let hasTaxableItem = false;

  for (const line of qbInvoiceLines) {
    if (line.SalesItemLineDetail.TaxCodeRef.value === "TAX") {
      hasTaxableItem = true;
    }
    payload.Line.push(line);
  }

  // Inyectar Regla Global de Impuestos
  if (hasTaxableItem) {
    payload.TxnTaxDetail = {
      TxnTaxCodeRef: { value: config.quickbooks.defaultTaxCodeId.toString() }
    };
  }

  return payload;
};

module.exports = { mapLineItemToQb, mapInvoicePayload };