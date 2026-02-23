# n8n-nodes-telegram

Community node para [n8n](https://n8n.io) com integração Telegram via **Telethon** usando um serviço Python local.

- Homepage: `https://github.com/ThalesTayson/n8n-nodes-telegram`
- Repository: `https://github.com/ThalesTayson/n8n-nodes-telegram.git`
- Issues: `https://github.com/ThalesTayson/n8n-nodes-telegram/issues`

## O que este pacote oferece

- Credencial `Telethon API Credentials` com autenticação por telefone (código e 2FA)
- Node `Telethon Trigger` para puxar eventos de mensagem recebida
- Node `Telethon Send Message` para enviar texto e/ou arquivo (base64)

## Pré-requisitos

- Node.js 18+
- Python 3.10+
- Conta Telegram com `api_id` e `api_hash`

## Como obter API ID e API Hash do Telegram

1. Acesse `https://my.telegram.org`
2. Faça login com o número da conta Telegram
3. Entre em **API Development Tools**
4. Crie uma aplicação (se ainda não tiver)
5. Copie os campos:
   - `api_id`
   - `api_hash`

## Configuração da credencial no n8n

Crie uma credencial do tipo **Telethon API Credentials** e preencha:

- `API ID`: valor do `api_id`
- `API Hash`: valor do `api_hash`
- `Phone`: telefone em formato internacional (ex: `5511999999999`)
- `Code`: deixe vazio no primeiro teste
- `2FA Password`: preencha somente se sua conta tiver verificação em duas etapas

### Fluxo de autenticação da credencial

1. Clique em **Test** com `Code` vazio  
   O Telegram envia o código e a resposta esperada é `code_required`.
2. Preencha `Code` e clique em **Test** novamente.
3. Se sua conta tiver 2FA e retornar `2fa_required`, preencha `2FA Password` e teste de novo.
4. Com sucesso, a sessão fica autenticada para uso nos nodes.

## Como funciona o Telethon Trigger

O **Telethon Trigger**:

- Registra um listener no serviço Python ao iniciar
- Recebe eventos do Telegram via webhook do n8n
- Em teste manual, fica em `Executing node...` até chegar uma nova mensagem
- Ao parar o teste/manual listening, faz `unregister` do listener

## Como funciona o Telethon Send Message

O **Telethon Send Message** envia mensagens para um `Chat ID` usando a sessão da credencial.

Parâmetros:

- `Chat ID` (obrigatório)
- `Message` (opcional se `File Base64` for informado)
- `File Base64` (opcional)
- `File Name` (opcional, padrão `file.bin`)
- `Parse Mode` (`None`, `Markdown`, `HTML`)
- `Reply To Message ID` (opcional)
- `Silent` (opcional)

Regras:

- Você precisa informar `Message` ou `File Base64`
- Se a sessão não estiver autenticada, o node retorna erro orientando a testar a credencial novamente

## Troubleshooting rápido

- Trigger fica em `Executing node...`: comportamento esperado até chegar mensagem nova.
- Não recebe dados no trigger: valide se a credencial está autenticada e se o serviço Python está saudável em `GET /health`.
- Erro de autenticação: refaça o **Test** da credencial com `Code` e, se necessário, `2FA Password`.

## Licença

[MIT](./LICENSE.md)
