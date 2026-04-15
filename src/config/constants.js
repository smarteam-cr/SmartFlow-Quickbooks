module.exports = {
  DEFAULT_TENANT_ID: process.env.DEFAULT_TENANT_ID || 'cliente-oficial-1',
  
  JOB_STATUS: {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    RETRY_PENDING: 'retry_pending',
    SUPPRESSED: 'suppressed',
    SKIPPED: 'skipped',
    DEAD_LETTER: 'dead_letter',
  },
  
  SOURCES: {
    HUBSPOT: 'HUBSPOT',
    QUICKBOOKS: 'QUICKBOOKS',
    INTERNAL: 'INTERNAL',
  },
  
  ENTITIES: {
    CONTACT: 'contact',
    COMPANY: 'company',
    PRODUCT: 'product',
    INVOICE: 'invoice',
    PAYMENT: 'payment',
    LINE_ITEM: 'line_item',
    HS_PAYMENT: 'hs_payment',
  },
  
  // Propiedades mapeadas de HubSpot que disparan sincronización
  MAPPED_HS_PROPS: {
    contact: ['firstname', 'lastname', 'email', 'phone', 'address', 'city', 'state', 'zip', 'country', 'hs_whatsapp_phone_number'],
    company: ['name', 'nit', 'phone', 'domain', 'address', 'city', 'state', 'zip', 'country'],
    product: ['name', 'price', 'hs_price_usd', 'description', 'hs_sku', 'es_gravable'],
  },
  
  // Propiedades generadas internamente en HS (ignoradas en webhooks para suprimir ecos)
  HS_SYSTEM_PROPS: [
    'id_usuario_quickbooks',
    'id_producto_quickbooks',
    'id_factura_quickbooks',
    'numero_factura_qb',
    'qb_sync_token',
    'qb_total_amount',
    'qb_tax_amount',
    'saldo_pendiente_qb',
    'qb_discount_amount',
    'estado_de_la_factura',
    'importe_pagado_qb',
  ],
};