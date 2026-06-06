# knowledge-hub

개인 AI 지식 허브. Claude Code / ChatGPT 등과 나눈 대화를 "아카이브해" 한 마디로 캡처해서, Obsidian 볼트에 지식으로 쌓아주는 프로그램입니다.

아카이브하면:

- 대화 원본을 `raw/`에 그대로 저장하고
- 백그라운드 LLM 워커가 유저 질문 기준으로 주제를 나눠 `notes/`에 주제별 노트(EN+한국어)로 정리하고 — 이미 비슷한 주제 노트가 있으면 거기에 병합
- 핵심 개념은 `knowledge/` 엔티티 페이지로, 플로우 설명이나 어려웠던 주제는 `canvas/` 개념 맵으로 만들어줍니다

볼트는 git으로 관리되고, 커밋 메시지에 무슨 내용을 아카이브했는지 남습니다.

## Obsidian 플러그인 (필수)

볼트를 제대로 보려면 Obsidian에 다음 플러그인을 **꼭 켜야 합니다**:

- **Smart Connections** (커뮤니티 플러그인) — 노트/엔티티 간 의미 기반 연결·추천
- **Canvas** (코어 플러그인) — `canvas/`의 개요·개념 맵 열람, 위키링크 그래프 노드 렌더링

## 사용법 (테스트용)

MCP 서버를 호스팅해서 씁니다.

```bash
pnpm install && pnpm build
kh setup                 # 볼트 경로, LLM 인증 설정

# Claude Code: stdio MCP 서버
#   mcpServers에 { "knowledge-hub": { "command": "kh-mcp" } } 등록

# ChatGPT: HTTP MCP 서버를 띄우고 터널로 노출 후 커넥터에 등록
kh-mcp-http --no-auth    # (또는 KH_MCP_NO_AUTH=1 kh-mcp-http)
pnpm tunnel
```

인증을 넣고 싶다면 별도로 알아서 셋팅하세요 — `--no-auth` 없이 띄우고 Bearer 토큰(16자 이상)을 주면 됩니다. 토큰 1개면 `KH_MCP_TOKEN`, 여러 개를 허용하는 화이트리스트면 `KH_MCP_TOKENS`(쉼표/공백 구분):

```bash
KH_MCP_TOKEN=$(openssl rand -hex 32) kh-mcp-http          # 단일 토큰
KH_MCP_TOKENS="$TOKEN_A,$TOKEN_B,$TOKEN_C" kh-mcp-http      # 화이트리스트
```

클라이언트는 `Authorization: Bearer <토큰>` 헤더로 접속하고, 목록에 없는 토큰은 401로 거부됩니다.

이후 대화 중에 "아카이브해" / "이 답변만 아카이브해" 라고 말하면 됩니다.
