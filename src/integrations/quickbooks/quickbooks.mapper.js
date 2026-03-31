const { formatToQbDate } = require('../../utils/date.util');

const mapLineItemToQb = (hsItem, qbItemId) => {
  const price = Number(hsItem.properties.price || 0);
  const qty = Number(hsItem.properties.quantity || 1);
  const isTaxable = hsItem.properties.es_gravable === "true";

  return {
    Amount: price * qty,
    Description: hsItem.properties.description || hsItem.properties.name,
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      ItemRef: { value: qbItemId.toString() },
      UnitPrice: price,
      Qty: qty,
      TaxCodeRef: { value: isTaxable ? "TAX" : "NON" }
    }
  };
};

const mapInvoicePayload = (hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo) => {
  const payload = {
    CustomerRef: { value: qbCustomerId.toString() },
    Line: qbInvoiceLines,
    TxnDate: formatToQbDate(hsInvoice.properties.hs_invoice_date),
    DueDate: formatToQbDate(hsInvoice.properties.hs_due_date),
    CustomerMemo: {
      value: hsInvoice.properties.hs_title || `Factura exportada desde HubSpot`
    }
  };

  if (contactInfo) {
    const { displayName, address, city, state, zip, country } = contactInfo;
    
    // Concatenamos la dirección con todos los datos disponibles
    const addressParts = [address, city, state, zip, country].filter(part => !!part);
    const fullAddress = addressParts.join(', ');

    payload.BillAddr = {
      Line1: displayName,
      Line2: fullAddress
    };
  }

  return payload;
};

module.exports = { mapLineItemToQb, mapInvoicePayload };