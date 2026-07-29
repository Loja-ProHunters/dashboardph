# ✅ INSTRUÇÃO DE UPLOAD MANUAL - PORTAL PRO HUNTERS

## 📋 O que fazer:

1. **Acesse o GitHub**
   - Vá para: https://github.com/Loja-ProHunters/dashboardph

2. **Para CADA arquivo neste ZIP:**

   ### Para arquivos que JÁ EXISTEM (substituir):
   
   a. Clique no arquivo (ex: `api/index.js`)
   b. Clique no ✏️ (lápis) para editar
   c. Delete TODO o conteúdo (Ctrl+A → Delete)
   d. Cole o conteúdo do arquivo novo
   e. Na seção "Commit changes", coloque a mensagem:
      ```
      ✨ Atualizar [nome do arquivo]
      ```
   f. Clique em "Commit changes"

   ### Para arquivos NOVOS (se não existirem):
   
   a. Acesse a pasta correspondente (ex: `/lib`)
   b. Clique em "Add file" → "Create new file"
   c. Digite o nome do arquivo
   d. Cole o conteúdo
   e. Commit

---

## 📁 ORDEM DE UPLOAD:

1. `package.json` — Dependências
2. `config.js` — Configuração
3. `api/index.js` — Backend principal
4. `system_prompt.js` — Prompt do AI
5. `lib/contracts.js` — Geração de contratos
6. `lib/gt.js` — Geração de GTs
7. `lib/nfExtract.js` — Extração de NF
8. `lib/pedidoExtract.js` — Extração de pedido
9. `lib/comercialStore.js` — Storage comercial
10. `dashboard.html` — Portal (Frontend)
11. `comercial-dashboard.html` — Dashboard comercial

---

## ⏱️ TEMPO TOTAL:
- ~5-10 minutos para upload
- +3 minutos para Vercel fazer deploy
- = **Portal online em ~15 minutos**

---

## ✨ DEPOIS DO UPLOAD:

1. Aguarde 3 minutos para Vercel fazer deploy automático
2. Abra o portal: https://dashboardph.vercel.app
3. Faça login
4. Teste: Documentos → Guias de Trânsito
5. Tudo deve funcionar! ✅

---

## 🆘 SE NÃO FUNCIONAR:

- Aguarde +5 minutos
- Faça hard refresh: **Ctrl+Shift+R** (Windows) ou **Cmd+Shift+R** (Mac)
- Limpe cookies e cache
- Verifique se todos os arquivos foram atualizados

