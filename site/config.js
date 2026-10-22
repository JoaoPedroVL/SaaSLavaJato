/* =============================================================
   Configuração pública da landing.
   A anon key é pública por design: quem protege os dados é o RLS
   e as views (public_tenants / public_services / public_hours).
   Em produção, cada lava-jato recebe a sua config (ou o slug vem da URL).
   ============================================================= */
window.LAVA_CONFIG = {
  supabaseUrl: "https://mcccxsovuouleorxfgnr.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jY2N4c292dW91bGVvcnhmZ25yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0NTIyNzMsImV4cCI6MjEwODAyODI3M30.zbgInFKsAkIk6lpnnXRnaBRbkzBEAxgTghTPiPPo2D0",

  // ?loja=demo-b troca de tenant sem precisar de outra página
  tenantSlug: new URLSearchParams(location.search).get("loja") || "caprichoso",

  // usado só se o banco não responder (o número real vem do tenant)
  fallbackWhatsapp: "5527997484755"
};
