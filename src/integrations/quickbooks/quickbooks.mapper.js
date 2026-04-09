const { formatToQbDate } = require('../../utils/date.util');
const config = require('../../config');

const mapLineItemToQb = (hsItem, qbItemId) => {
  const price = Number(hsItem.properties.price || 0);
  const qty = Number(hsItem.properties.quantity || 1);
  
  // Condición estricta: es_gravable activado o tiene una tasa asignada nativamente
  const isTaxable = hsItem.properties.es_gravable === "true" || !!hsItem.properties.hs_tax_rate_group_id;

  return {
    Amount: price * qty,
    Description: hsItem.properties.description || hsItem.properties.name,
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      ItemRef: { value: qbItemId.toString() },
      UnitPrice: price,
      Qty: qty,
      TaxCodeRef: { value: isTaxable ? "TAX" : "NON" }
    },
    // Almacenamos temporalmente las propiedades originales para cálculos en el mapper padre
    _originalHsProperties: hsItem.properties 
  };
};

const mapInvoicePayload = (hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo) => {
  const payload = {
    CustomerRef: { value: qbCustomerId.toString() },
    Line: [],
    TxnDate: formatToQbDate(hsInvoice.properties.hs_invoice_date),
    DueDate: formatToQbDate(hsInvoice.properties.hs_due_date),
    CustomerMemo: {
      value: hsInvoice.properties.hs_title || `Factura exportada desde HubSpot`
    }
  };

  if (contactInfo) {
    const { displayName, address, city, state, zip, country } = contactInfo;
    const addressParts = [address, city, state, zip, country].filter(part => !!part);
    payload.BillAddr = { Line1: displayName, Line2: addressParts.join(', ') };
  }

  let totalDiscountAmount = 0;
  let hasTaxableItem = false;

  for (const line of qbInvoiceLines) {
    // 1. Evaluar si la factura general necesita el TxnTaxDetail global
    if (line.SalesItemLineDetail.TaxCodeRef.value === "TAX") {
      hasTaxableItem = true;
    }

    // 2. Extracción de descuentos en valor absoluto
    const props = line._originalHsProperties;
    if (props) {
      if (props.hs_discount_amount) {
        totalDiscountAmount += Number(props.hs_discount_amount);
      } else if (props.hs_discount_percentage) {
        const lineTotal = line.Amount; // Usamos el Amount ya calculado (price * qty)
        totalDiscountAmount += lineTotal * (Number(props.hs_discount_percentage) / 100);
      }
      delete line._originalHsProperties; // Limpieza del objeto temporal
    }
    
    payload.Line.push(line);
  }

  // 3. Inyectar línea de Descuento Absoluto Global
  if (totalDiscountAmount > 0) {
    payload.Line.push({
      Amount: totalDiscountAmount,
      DetailType: "DiscountLineDetail",
      DiscountLineDetail: { PercentBased: false }
    });
    // Determina que el impuesto se calcula sobre el subtotal restante
    payload.ApplyTaxAfterDiscount = true; 
  }

  // 4. Inyectar Regla Global de Impuestos
  if (hasTaxableItem) {
    payload.TxnTaxDetail = {
      TxnTaxCodeRef: { value: config.quickbooks.defaultTaxCodeId.toString() }
    };
  }

  return payload;
};

module.exports = { mapLineItemToQb, mapInvoicePayload };