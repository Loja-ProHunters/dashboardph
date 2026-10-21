-- ============================================================
-- Supabase setup — CRM docs (Migração Fase 1)
-- Rodar no SQL Editor do Supabase (supabase.com → projeto → SQL Editor)
-- ============================================================

-- Tabela única para todas as coleções CRM.
-- Cada doc é uma linha: coleção + id + JSONB com o doc inteiro.
-- Isso reaproveita 100% do código atual — mesma shape dos JSONs.
CREATE TABLE IF NOT EXISTS crm_docs (
  colecao        TEXT        NOT NULL,             -- 'accounts', 'orders', 'activities', etc
  id             TEXT        NOT NULL,             -- UUID do documento
  data           JSONB       NOT NULL DEFAULT '{}', -- o doc inteiro como JSON
  owner_id       TEXT,                              -- vendedor dono (pra filtros rápidos)
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_por     TEXT,
  atualizado_por TEXT,
  PRIMARY KEY (colecao, id)
);

-- Índice por coleção (listagem de todos os docs de uma coleção)
CREATE INDEX IF NOT EXISTS idx_crm_docs_colecao
  ON crm_docs (colecao);

-- Índice por coleção + owner (filtragem por vendedor)
CREATE INDEX IF NOT EXISTS idx_crm_docs_owner
  ON crm_docs (colecao, owner_id);

-- Índice por coleção + atualizado_em (ordenação por recência)
CREATE INDEX IF NOT EXISTS idx_crm_docs_atual
  ON crm_docs (colecao, atualizado_em DESC);

-- GIN para busca em qualquer campo do JSON
CREATE INDEX IF NOT EXISTS idx_crm_docs_data_gin
  ON crm_docs USING GIN (data);
