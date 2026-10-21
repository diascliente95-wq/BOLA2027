# Backend PIX Efí — Bolão Copa Feminina 2027

Este backend é necessário porque o GitHub Pages só hospeda arquivos estáticos. Ele guarda as credenciais no servidor, cria cobranças PIX reais via SDK oficial Efí, grava palpites pendentes no Firebase e só marca como confirmado após receber notificação e consultar a cobrança na API Efí.

## Antes de ativar
- Abra uma conta Efí Bank, conclua a verificação exigida e cadastre uma chave Pix.
- No painel Efí, crie uma aplicação com API Pix e libere os escopos de homologação; depois solicite/libere produção.
- Gere o certificado Pix do ambiente escolhido e guarde o arquivo P12.
- Configure um serviço Node.js 22+ com HTTPS e variáveis secretas de ambiente.
- Configure Firebase Admin com uma conta de serviço; não publique o JSON no repositório.
- Configure as regras do Realtime Database para impedir que clientes alterem palpites/pagamentos e campos de confirmação diretamente. O backend usa Firebase Admin e não depende dessas regras.
- Configure o webhook Efí para a URL `https://SEU-DOMINIO/api/efi/webhook/SEU_SEGREDO`; a Efí envia callbacks em `/pix`. O servidor deve suportar mTLS conforme a documentação oficial Efí. A validação por segredo na URL é camada adicional, não substitui mTLS.
- Defina `EFI_SANDBOX=true` para homologação e `false` somente quando conta, certificado, chave e aplicação de produção estiverem liberados.

## Variáveis secretas
Copie `.env.example` para seu gerenciador de variáveis (não faça commit de valores reais):
- `FIREBASE_SERVICE_ACCOUNT_JSON`: JSON inteiro da conta de serviço.
- `FIREBASE_DATABASE_URL`: URL do Realtime Database.
- `EFI_CLIENT_ID`, `EFI_CLIENT_SECRET`, `EFI_PIX_KEY`.
- `EFI_CERTIFICATE_BASE64`: conteúdo Base64 do certificado P12.
- `EFI_WEBHOOK_SECRET`: segredo aleatório longo.
- `FRONTEND_ORIGIN`: origem do site, sem caminho.

## Rotas
- `GET /health`: estado básico de configuração.
- `POST /api/pix/create`: cria cobrança e palpite pendente.
- `GET /api/pix/status/:id`: consulta o estado do palpite.
- `POST /api/efi/webhook/:secret/pix`: recebe notificação, consulta status na Efí e confirma o palpite.

## Observações
Este código não pode receber pagamentos até você abrir a conta, gerar as credenciais/certificado e hospedar o backend. Não é suficiente publicar o arquivo no GitHub Pages. Teste primeiro no ambiente de homologação e faça uma revisão das regras Firebase antes de usar dinheiro real.
