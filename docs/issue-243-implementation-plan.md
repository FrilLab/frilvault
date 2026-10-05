# Issue #243 구현 계획 및 에이전트 인수인계

계획 작성일: 2026-10-04. 실행 결과는 2026-10-04 추가. 대상: [#243 — Edit notes beside code with a compact UI and reliable autosave](https://github.com/FrilLab/frilvault/issues/243).

이 문서는 계획과 API feasibility 실행 결과를 담는다. Extension Host PoC에서 decoration은 실제 입력면이 아니었고, native Comments 입력면은 편집 가능하지만 코드 줄을 아래로 밀며 별도 tags 필드가 없다. Quick Input은 전역 단일 행이다. 따라서 현재 #243 계약에 맞는 stable public UI를 확인하지 못해 제품 편집면과 autosave를 구현하지 않고, 재현 가능한 PoC와 maintainer 대안 선택을 Draft PR로 전달한다. 상세 근거와 screenshot은 [feasibility 결과](issue-243-feasibility.md)를 본다.

## 1. 목표와 범위

소스 앵커 근처에서 짧은 Markdown 본문과 태그를 편집하고, 마지막 입력을 안전하게 저장하거나 복구한다. 원본 소스 파일은 바이트 단위로 보존한다.

| 항목 | 계약 |
| --- | --- |
| 우선 UI | 오른쪽 첫 줄 preview 위치를 실제 입력 가능한 편집면으로 전환 |
| 허용된 fallback | 앵커 근처에 떠 있는 작은 임시 편집기. 임시 겹침은 허용하되 소스의 가로·세로 배치를 밀지 않음 |
| API 제약 | stable public VS Code API만 사용. DOM 주입, 내부 Monaco, proposed/private API 금지 |
| 편집 대상 | #242 통합 Add/Edit 및 canonical anchor/정확한 note ID 재사용 |
| 저장 | 기존 CLI → Core 경계를 통한 autosave가 기본. 입력 revision과 저장 완료 revision을 분리 |
| 표시 | 본문·태그 중심, 작은 초기 높이와 제한된 성장·내부 스크롤, 테마에 맞는 경계, 접근 가능한 이름 |
| 읽기 상태 | 첫 번째 비어 있지 않은 논리 줄 preview, expanded 기본값, collapsed에서는 preview 숨김, 전체 Markdown Hover 유지 |
| 제외 | 새 저장 backend, source mutation, 세 번째 VS Code integration, storage policy 변경, 대규모 panel redesign, 완전한 Markdown editor |

**고정 sidebar나 별도 editor tab을 이슈의 편집 UI로 대체해서는 안 된다.** 우선 UI와 fallback 모두 불가능하면, 이슈가 지시한 feasibility 결과와 구체적인 대안 제안까지만 전달한다. 이 경우 #243 완료나 `Closes #243`를 선언하지 않는다.

## 2. 확인된 저장소 상태

- 구현 branch: `feat/243-compact-note-editor`.
- 시작 때의 branch HEAD: `8ae4a36` — #244 refresh 안정화 PR merge.
- 확인하고 branch base로 사용한 `upstream/main`: `c972f01` — #245 통합 Add/Edit PR merge.
- `origin`: `https://github.com/mors119/frilvault.git`, `upstream`: `https://github.com/FrilLab/frilvault.git`.
- 구현 시작 때 작업 tree 변경은 기존 이 계획 문서뿐이었다. 최신 `upstream/main`에서 별도 issue branch를 만들고 이 문서를 보존했다.
- VS Code engine과 `@types/vscode`는 `1.125.0` 기준이다. `.vscode-test.mjs`는 테스트 버전을 명시하지 않는다. 실행 시 실제 버전을 반드시 기록한다.
- extension `npm ci` 후 `npm test`가 실제 VS Code 1.140.0 Extension Host(macOS arm64)에서 265 passing, 1 pending으로 통과했다. GUI PoC도 같은 VS Code 1.140.0에서 실행했다.
- `main`은 다른 worktree에서 사용 중이다. 이 worktree에서 무조건 `git switch main`을 실행하지 않는다.

| 선행 작업 | 확인한 상태 | 다음 작업에 주는 의미 |
| --- | --- | --- |
| [#242](https://github.com/FrilLab/frilvault/issues/242) / [#245](https://github.com/FrilLab/frilvault/pull/245) | issue CLOSED, PR MERGED | 최신 base에 있는 command dispatch, Vault 고정, recovery identity를 먼저 확보 |
| [#241](https://github.com/FrilLab/frilvault/issues/241) / [#244](https://github.com/FrilLab/frilvault/pull/244) | issue OPEN, PR MERGED | refresh 안정화 코드는 존재. issue가 open인 이유와 남은 acceptance를 재확인 |
| [#231](https://github.com/FrilLab/frilvault/issues/231) | OPEN | 저장·닫기 regression 코드가 존재하나 완료를 가정하지 않음 |
| [#232](https://github.com/FrilLab/frilvault/issues/232) | OPEN | compact presentation/Hover 변경과 충돌하지 않도록 현재 상태·연관 PR 재확인 |

#245에 VS Code 1.140.0 macOS Extension Host/GUI 검증 결과가 기록되어 있다. 이는 **선행 PR 작성자의 검증 기록**이며 #243 UI 검증 또는 이번 에이전트의 테스트 결과가 아니다. 현 UI를 사용한 선행 검증을 새로운 편집면의 증거로 재사용하지 않는다.

### #243 실행 업데이트

- PoC: `apps/vscode-extension/feasibility/issue-243/`. VS Code 1.140.0 macOS arm64에서 stable `TextEditorDecorationType`, `CommentController`, `window.showInputBox`를 실제 Extension Development Host로 띄웠다.
- Native comment thread의 multiline Markdown 편집기에 `한글 입력`, newline 및 추가 Markdown 줄을 CDP의 실제 `Input.insertText`로 보냈다. 이는 Hangul 텍스트 수용 증거이며 한국어 IME 조합 동작 증거는 아니다.
- 화면에서 thread widget이 source line 3 바로 아래 editor 공간을 차지하고 아래 코드 줄을 밀어내는 것을 확인했다. 기본 native comment editor의 높이·레이아웃은 extension API가 제어하지 못한다. body와 tags를 분리한 입력 field도 제공되지 않는다.
- `showInputBox`는 editor 상단의 Quick Input UI로 나타나 anchor에 위치하지 않고 단일 행이다.
- PoC 입력 중 `sample.js` bytes는 SHA-256 `4519269f846c489c5b2d423c1f91134973c2e57aa7058659a6303afb6ecc0eed`로 전후 일치했다.
- Screenshot: [`native Comments API`](assets/issue-243-comments-api-1.140.0.png), [`Quick Input`](assets/issue-243-quick-input-1.140.0.png). 조사 근거, 수동 확인 범위와 아직 확인하지 않은 항목은 [feasibility 보고서](issue-243-feasibility.md)에 있다.
- 검증: `npm test` 통과 (265 passing, 1 pending); Rust `cargo fmt`, `cargo check`, `cargo clippy` 통과. 기본 병렬 `cargo test --workspace --all-features`는 tag fixture 테스트에서 한 번 실패했다. 해당 테스트 단독은 통과했고 `RUST_TEST_THREADS=1 cargo test --workspace --all-features` 전체는 통과했다. 기존 test fixture의 임시 경로 충돌 가능성이 원인 후보이며 이번 branch에서는 변경하지 않았다.
- 저장/복구 production 코드 변경은 진행하지 않았다. native UI no-go이므로 #231/#241/#242 수명주기 통합과 #243 저장 acceptance는 이 PR에서 완료됐다고 주장하지 않는다.

## 3. 다음 에이전트의 시작 순서

1. `AGENTS.md`, `docs/github-workflow.md`, `docs/testing.md`, `docs/RELEASES/PROCESS.md`, `.github/PULL_REQUEST_TEMPLATE.md`를 읽는다.
2. `git status --short`, `git remote -v`, `git worktree list`를 확인한다. 이 문서와 사용자의 다른 변경을 보존한다. 자동 stash/reset/cleanup을 하지 않는다.
3. #243 본문·댓글, #231/#241/#242/#232 및 관련 open PR을 다시 확인한다. 기존에 #243을 해결하는 PR이 생겼다면 중복 작업하지 않는다.
4. `git fetch upstream` 후 최신 base를 확인한다. 기존 branch의 고유 commit/사용자 변경을 확인하고 안전한 경우 `feat/243-compact-note-editor`를 `upstream/main`에서 생성한다. issue-linked fork branch를 우선하되 도구가 worktree 구성과 맞지 않으면 일반 Git branch 생성 이유를 기록한다. 이 계획 문서도 보존한다.
5. 최신 base의 extension `package.json`과 실제 script를 확인하고 extension 디렉터리에서 `npm ci`를 실행한다. PoC 이전에 기존 `npm test` baseline을 기록한다. 실패하면 base 문제인지 환경 문제인지 분리한다.
6. 작업 범위를 PR에 옮기기 전에 다음 한 문장으로 고정한다: “supported API에서 code-adjacent input을 먼저 증명하고, 가능할 때만 기존 target/save lifecycle에 연결한다.”

현재 worktree의 코드만 읽으면 #242 최종 변경을 놓친다. 계획 작성 시 아래 코드 연결 지점은 `git show upstream/main:<path>`로 최신 내용을 확인했다.

## 4. Phase 1 — API feasibility 관문

### 조사 및 후보 판별

공식 API 문서와 최소 지원 버전의 `vscode.d.ts`를 함께 확인한다. 최신 문서에만 있는 기능은 engine `1.125.0` 지원으로 간주하지 않는다. API 부재를 우회하려고 engine을 임의로 올리지 않는다.

| 후보 | 현재 조사에서 보인 제약 | PoC에서 확인할 사항 |
| --- | --- | --- |
| `TextEditorDecorationType` / `after.contentText` | rendering 스타일·텍스트 API. 실제 text input API는 확인되지 않음 | 입력 focus/change/composition을 받을 documented API가 있는지. 문자열 decoration을 editable UI라고 주장하지 않음 |
| `Hover` / `MarkdownString` | Markdown rendering과 command link. HTML은 안전한 subset만 허용 | `supportHtml`로 textarea/form/JS가 가능한 것처럼 가정하지 않음. 링크 실행과 실제 anchored editor 생성은 별도로 판별 |
| `CodeLens` | command 실행 표면 | edit action 진입점에는 재사용 가능하나 본문 입력면 증거가 아님 |
| `InputBox` / Quick Input | 텍스트 입력 가능 | 앵커 위치 지정, multiline Enter, 별도 tags input, dismissal 통제 여부를 확인. 전역 single input을 fallback으로 선언하지 않음 |
| `WebviewPanel` / `WebviewView` / custom editor | HTML form을 호스팅할 수 있음. 공개 배치는 editor column/view 기반 | source anchor에 떠 있는 overlay를 만드는 stable API가 실제로 있는지 확인. 작은 CSS form만으로 floating UI가 되지 않음 |
| Comments API | source range에 연결된 native comment UI | 실제 입력은 가능하지만 layout displacement, 별도 tag field, live change/IME/dismissal 접근을 확인. 계약을 벗어나면 maintainer 선택용 대안으로만 기록 |

초기 문서 조사상 우선 UI와 floating fallback의 실현 가능성이 낮다. **아직 실현 불가를 확정한 실행 결과는 없다.** 조사 결과와 실제 PoC 결과를 분리해서 기록한다.

### 최소 Extension Host PoC

1. production command와 분리된 테스트 fixture 또는 개발 전용 PoC를 만든다. 기능이 없는 mock floating widget이나 새 persistence backend는 만들지 않는다.
2. disposable workspace의 짧은 소스 파일에 decoration preview와 edit action을 배치한다. 우선 입력면 후보를 시도하고, 지원되지 않으면 fallback 후보를 검증한다.
3. 본문 `한글 메모\n\n```rs\nfn main() {}\n```\n`와 별도 tags field를 실제로 편집한다. 문자열을 API로 주입하는 테스트와 실제 키 입력/IME 테스트를 구분한다.
4. Tab/Shift+Tab 이동, Enter newline, Escape dismissal, focus return, 접근성 이름과 focus indicator를 검증한다. 한국어 IME는 실제 입력기를 사용한다. 합성 composition event만으로 수동 검증 완료를 선언하지 않는다.
5. scroll, resize, 긴 소스 줄 wrapping, font/zoom, split editor에서 invoking anchor를 추적한다. 편집면이 anchor와 무관한 위치로 떠 있거나 소스 배치를 밀면 실패다.
6. 마지막 글자 입력 직후 닫아 input 전달·native dismissal 순서를 관찰한다. async disposal callback이 종료를 기다려 줄 것이라고 가정하지 않는다.
7. source bytes와 편집 전후 source layout을 비교한다. 기존 CodeLens 배치를 baseline으로 삼아 새 편집면에 의한 추가 displacement가 없는지 본다.
8. 실제 VS Code 버전, OS, engine compatibility, 사용 API, 재현 명령, screenshot/recording, 입력·focus·layout·dismissal 결과를 `docs/issue-243-feasibility.md`에 기록한다. PoC code는 저장소 재현이 가능해야 하며 production 활성화는 하지 않는다.

최소 지원 버전 `1.125.0`과 작업 시점 최신 stable을 대상으로 한다. 둘 중 실행할 수 없는 버전이 있으면 정확한 이유와 미검증 항목을 남긴다. GUI/CDP 자동화는 **검증용**으로만 사용하고 extension 제품 코드에 DOM/Monaco 접근을 넣지 않는다.

### Go / No-go 결정

| 결과 | 다음 행동 |
| --- | --- |
| 우선 입력면이 모든 필수 제약 충족 | 해당 API와 수명주기를 선택하여 Phase 2 진행 |
| 우선 입력면 불가, floating fallback이 충족 | fallback 선택 근거·제약·증거를 기록한 뒤 Phase 2 진행 |
| 둘 다 불가 | production 구현 중단. 재현 가능한 PoC/조사 결과와 대안 선택 문서만 Draft PR으로 전달. `Refs #243` 사용 |
| GUI나 최소 버전을 검증할 수 없음 | feasibility 미확정으로 기록. material acceptance가 남은 상태로 `Closes`를 쓰지 않음 |

No-go 때 제안할 구체적 선택지는 다음과 같다. 어느 것도 승인 없이 #243 구현으로 대체하지 않는다.

- Native Comments 편집: source range 연동과 native multiline input을 활용하는 대신, 세로 배치 변화와 tags/live-change 제약을 수용할지 결정한다. autosave를 증명하지 못하면 아래 explicit-save 조건도 별도로 적용한다.
- 기존 webview editor 유지: 현재 CLI/Core 및 recovery를 유지하면서 별도 tab/column UX를 명시적으로 수용할지 결정한다. 단순히 compact CSS로 바꾸는 것은 원래 요구사항 충족이 아니다.
- 계약 유지 및 보류: stable anchored input API가 제공될 때 다시 평가한다. proposed/private API나 별도 native window integration을 이번 범위에 추가하지 않는다.

## 5. Phase 2 — 가능한 입력면을 기존 코드에 연결

이 단계는 UI feasibility를 통과했을 때만 수행한다. PoC에서 지원되지 않은 API를 전제로 interface와 UI를 먼저 대량 작성하지 않는다.

### 재사용할 코드 연결 지점

아래 경로는 `apps/vscode-extension/src/` 기준이다.

| 파일 | 역할 및 변경 방향 |
| --- | --- |
| `features/inline-editor/command.ts` | #242 unified `frilvault.addOrEditNote`와 compatibility ID. target resolution을 복제하지 않고 새 편집면에 연결 |
| `features/inline-editor/sourceContext.ts` | eligible source/enablement/context guard 유지 |
| `features/inline-editor/editor.ts` | `captureTarget`, `openAtTarget`, `openDraft`, `handleChange`, `persistDraft`, controlled/native close, suspend/resume를 재사용. UI adapter 연결만 필요한 만큼 변경 |
| `features/inline-editor/panel.ts` | 기존 `InlineNotePanelLike`와 message contract, state update 참고. 표면이 다르면 최소 범위에서 adapter를 분리하되 persistence controller는 공유 |
| `features/inline-editor/draft.ts` | workspace/Vault/file/anchor/note ID/expectedUpdatedAt 입력 snapshot 보존 |
| `features/inline-editor/autoSave.ts` | revision scheduling·직렬 저장·composition suppression 재사용. watcher debounce와 분리 |
| `features/inline-editor/draftRecovery.ts` | workspaceState recovery, session/revision 보호, create→edit identity 및 legacy compatibility 보존 |
| `features/inline-editor/service.ts` | `clientForDraft`와 `saveDraft`로 기존 CLI/Core mutation 사용 |
| `core/cliClient.ts` | `withVaultPath`, add/update와 conflict optimistic check. UI 전용 저장 경로 추가 금지 |
| `features/note-viewer/noteViewerCommands.ts` | 특정 control의 note identity와 unified action 유지 |
| `features/note-viewer/noteViewerController.ts`, `noteViewerRenderer.ts`, `noteViewerModel.ts` | read-only preview, `firstNonEmptyLogicalLine`, disclosure 유지. editor refresh 때문에 input surface를 재생성하지 않음 |
| `features/presentation/noteHover.ts` | full Markdown source-position Hover 유지 |
| `features/refresh/contextualRefresh.ts`, `features/current-file/saveRefresh.ts` | #241의 context-scoped refresh 연결을 유지. 저장 재시도와 presentation retry 분리 |

anchor identity 변경, 중복 방지, 저장 규칙처럼 재사용되는 domain behavior가 정말 필요하면 `crates/frilvault-core`에 둔다. 현재 계획은 기존 identity와 저장 경로 재사용을 우선하며 Core/CLI 대규모 변경을 예정하지 않는다.

### 세션과 UI 계약

1. 하나의 활성 편집 세션을 유지하는 현재 동작을 활용한다. 같은 note 재호출은 reveal/focus만 수행하고 draft를 reset하지 않는다. 다른 note 전환은 기존 저장·복구가 안전해진 뒤 진행한다.
2. workspace root, 실제 선택된 absolute Vault path, file, canonical anchor, note ID, expectedUpdatedAt을 세션에 고정한다. invoking source editor의 URI, view column, selection도 별도로 캡처하여 위치와 focus 복귀에 사용한다. UI 위치 이동이 저장 대상을 변경해서는 안 된다.
3. 기존 note control은 정확한 ID를 편집한다. cursor command는 Line/Symbol ambiguity와 legacy duplicate 선택을 #242 규칙으로 처리한다. Line은 1-based line/column, Symbol은 name/kind/signature이며 이동하는 line hint는 identity가 아니다.
4. 최소 본문 2~4줄에서 시작해 PoC로 검증한 최대 높이까지 성장하고 이후 내부 scroll한다. 숫자는 구현 가정이며 실제 anchor UI 공간에서 조정한다. tags는 별도 필드로 두고 긴 태그와 keyboard suggestion을 지원한다.
5. theme-aware background/border, screen-reader label, tooltip, focus indicator, 작은 save status를 제공한다. 본문에 `FrilVault Note` 접두어를 삽입하지 않는다.
6. Enter는 newline, Tab/Shift+Tab은 body/tags/actions 이동. Escape는 autosave flush/recovery 뒤 dismiss하며 저장된 편집을 undo한다고 표현하지 않는다. tags suggestion이 열렸을 때 첫 Escape는 suggestion만 닫는 동작을 문서화한다.
7. IME composition 중 Enter/Escape 등 키를 가로채지 않는다. `isComposing` 등 플랫폼 상태를 존중하고 최종 committed input을 한 번 반영한다. native close가 composition 도중 일어난 경우의 복구 가능 범위를 별도로 기록한다.
8. 정상 close는 invoking source editor/location에 focus를 반환한다. source가 사라졌거나 editor가 닫힌 경우에는 안전한 best-effort 동작을 정의한다. focus loss/file switch를 무조건 dismiss로 취급하지 않는다.
9. status/tag suggestions/background refresh는 입력 값·selection·scroll·focus를 교체하거나 UI를 remount하지 않는다. 외부 버전 명시적 load 같은 의도된 작업에서만 입력을 교체한다.

## 6. Phase 3 — autosave와 durability

### 기존 동작에서 먼저 재현할 지점

다음은 코드에서 확인한 구현 및 검증 후보다. 테스트로 증명하기 전까지 전부 새로운 확정 bug라고 선언하지 않는다.

| 지점 | 확인한 구현 | 필요한 regression |
| --- | --- | --- |
| 본문 보존 | `service.saveDraft`는 add/update 전에 `content.trim()` 호출. `draftFingerprint`도 본문을 trim | leading/trailing newline·공백·Markdown hard break와 whitespace-only edit가 저장/reopen 후 정확히 보존되는지. 빈 본문 검증과 mutation payload를 분리 |
| 새 빈 초안 | 초기 무변경 빈 draft는 fingerprint가 같아 저장을 건너뜀. 공백 입력/태그만 입력 후 close는 validation/save 실패 경로에 들어갈 수 있음 | empty/whitespace/작성 후 삭제/tag-only 각각 orphan note 없이 dismiss 또는 recoverable draft 처리 |
| stale completion | `persistDraft`에서 metadata 동기화 후 `panel.updateDraft(... status: 'saved')` 수행 | revision N 저장 중 N+1 입력 시 최신 revision이 저장되기 전 saved 표시·clean 판정이 되지 않는지 |
| refresh와 저장 분리 | mutation 성공 뒤 `persistDraft`가 refresh와 tag suggestion을 await. 예외는 별도로 처리 | 느린/실패한 presentation refresh가 다음 mutation 또는 controlled close를 불필요하게 막는지. 필요할 때만 기존 callback 경계를 조정 |
| recovery 경계 | `handleChange`는 recovery write를 await하지만 panel message/disposal 자체가 그 완료를 기다린다는 API 보장은 없음 | recovery write 실패·지연 중 immediate native close, 재실행 복구, 마지막 전달 안 된 input의 한계 |
| composition | input message는 composition 중 억제되고 close 버튼은 composition 종료를 요청 | 실제 Korean IME commit/cancel과 즉시 dismiss가 잘린 문자열·거짓 saved를 만들지 않는지 |

feasibility no-go이면 이 표의 결함 후보를 이번 문서 PR에 incidental fix로 추가하지 않는다. 가능한 UI 통합에 필요하거나 선행 이슈와 조율된 수정만 포함한다.

### 저장 규칙

- 입력마다 monotonic revision과 immutable snapshot을 만든다. snapshot은 원문 본문과 tagsText, 고정 target을 포함한다. 본문 dirty 비교에 destructive trim을 사용하지 않는다. 빈 본문 허용 여부 검증과 실제 전송 텍스트를 구분한다.
- mutation은 직렬화한다. revision N 저장 완료는 N만 persisted 처리하고 N+1 입력은 계속 dirty다. in-flight typing과 close가 겹쳐도 마지막 pending revision을 저장한다.
- 새 note의 첫 저장이 note ID/updatedAt을 반환하면 남은 snapshot에 persisted metadata를 전달한다. create draft recovery key에서 persisted note identity로 다시 찾는 #245 수정도 유지한다.
- 기존 tag parsing/canonical semantics를 보존한다. 정상 태그를 임의로 삭제·정렬하거나 본문에서 태그를 추출하는 정책을 추가하지 않는다.
- 저장 실패는 failed 상태와 editable/recoverable 내용을 유지하고 Retry를 제공한다. 회복 불가한 상태를 saved로 표시하지 않는다.
- `expectedUpdatedAt` conflict 보호를 유지한다. local/external 선택 없이 오래된 recovered draft를 덮어쓰지 않는다. 기존 note 삭제/중복 create race도 actionable 결과로 처리한다.
- mutation이 성공한 뒤 refresh가 실패하면 mutation 성공은 유지한다. presentation retry가 add/update를 재실행하지 않도록 한다.
- 새 body가 비어 있고 저장된 note가 없는 경우 add를 실행하지 않는다. tags-only 등 유의미한 입력은 필요한 recovery를 남기는 정책을 검증하고, persisted empty orphan을 만들지 않는다. 기존 note를 공백으로 바꾼 경우에는 기존 validation을 유지하고 본문 삭제를 암묵적 note 삭제로 바꾸지 않는다.

### 종료별 보장과 테스트 경계

| 종료 상황 | 구현·검증해야 할 보장 |
| --- | --- |
| extension-controlled Close/Escape | 최신 input 전달을 확인한 뒤 flush 및 최종 revision 저장 또는 실제 durable recovery를 await. 저장/복구 둘 다 실패하면 dismissal을 막고 retry |
| source file 전환 / 다른 note 열기 | 기존 target 불변. 선택한 presentation 정책에 따라 유지하거나 위 controlled close를 실행. 새 세션이 이전 completion을 받지 않음 |
| Vault/workspace 변경 | 기존 draft는 기존 Vault에만 저장/복구. 새 context의 input/status/recovery를 오염시키지 않음 |
| native dismissal / focus-loss dismissal | UI가 close를 지연할 수 있는지 PoC에서 확인. 불가능하면 **이미 전달되어 recovery write 완료가 확인된 revision**만 보장. timer/in-memory만으로 보호됐다고 주장하지 않음 |
| disable / reload / 정상 종료 | suspend/dispose 수명주기를 회귀 테스트. 수신·저장된 recovery revision의 재시작 복원을 검증하고 아직 전달 안 된 입력 보호를 약속하지 않음 |
| forced shutdown | 종료 직전 미전달 input 및 완료 안 된 storage write는 보장 밖. workspaceState update를 crash-proof fsync라고 표현하지 않음 |

surface event를 받은 사실과 durable recovery 저장 완료를 구분한다. webview 메시지 하나를 보냈다는 것만으로 마지막 글자 보존을 선언하지 않는다. chosen surface에 적절한 acknowledgement/종료 순서를 최소 범위에서 마련하고 immediate dismissal을 실제로 재현한다.

autosave가 지원 표면에서 신뢰성 있게 구현되지 못한다는 PoC/regression 증거가 있을 때만, 이슈에 허용된 explicit save contingency를 적용한다. Cmd/Ctrl+Enter 저장, dirty close 시 Save/Discard/Cancel 또는 durable recovery를 제공하고 근거를 문서화한다. 이 선택은 UI feasibility 실패를 해결하지 않으며, 기존 editor의 전역 저장 정책을 바꾸는 방식으로 적용하지 않는다.

## 7. 테스트 계획

결함 수정 전 또는 수정과 함께 behavior regression을 추가한다. async race는 deferred promise와 deterministic timer로 구성하며 단순 호출 횟수보다 저장된 최신 내용·현재 표시 상태·고정 target을 검증한다.

| 범주 | 필수 사례 | 기존 suite/검증 연결 |
| --- | --- | --- |
| target | new/existing Line, Symbol, 같은 표시 줄 공존, canonical line/column, moved/unresolved Symbol, legacy duplicate chooser·cancel | 최신 base `unifiedNoteCommand.test.ts`, `inlineEditorAddOrEdit.test.ts`, Core `note_service_test.rs` |
| session | same-note reveal 시 dirty 보존, split editor, 다른 editor focus, chooser/save 중 file/Vault 변경, 경쟁 open·disable | `inlineEditorRace.test.ts`와 #242 command suite |
| 마지막 입력 | final character 뒤 즉시 Escape/Close/native dismiss/reopen, in-flight save 중 마지막 입력, recovery write 지연·실패 | `autoSave.test.ts`, `inlineEditorRace.test.ts`, 선택 표면의 실제 Extension Host 테스트 |
| persistence | real CLI + temporary Vault의 add/update/reopen, conflict, create→edit recovery, tags 보존, Unicode 경로 | 실제 CLI/Core로 새 integration coverage. 기존 fake CLI 테스트만으로 실제 Vault 보장을 대신하지 않음 |
| 실패 | mutation failure→retry, recovery restore, 외부 최신 update, stale completion, save 성공→refresh failure | existing race suite 확장, optimistic update assertion |
| 텍스트 | multiline paste, leading/trailing blank lines, indentation, Markdown hard-break 공백, fenced blocks, Unicode/emoji, 긴 본문·태그 | service/Fingerprint regression 및 real persistence round trip |
| IME | composing 중 autosave 억제, commit 이후 최신 값, Enter/Escape 비간섭, paste+composition+close | deterministic composition tests + 실제 Korean IME 수동 검증 |
| 빈 초안 | no-input, whitespace-only, 본문 입력 후 삭제, tags-only dismissal, 기존 note를 빈 값으로 변경 | note count/ID/orphan 여부와 recovery 정책 검증 |
| refresh | typing 중 watcher/background refresh에도 focus/caret/text/tags/target/UI instance 보존 | `contextualRefresh.test.ts`, `currentFileNotesStore.test.ts`, `notesPanelRefresh.test.ts`, 실제 표면 테스트 |
| 기존 표시 | CodeLens, first logical line/default expanded/collapse, full Markdown Hover, Tags, native breakpoints | `noteViewerModel.test.ts`, `noteViewerState.test.ts`, `notesPresentation.test.ts`, `hoverPresentation.test.ts`, `richHover.test.ts`, `tagPresentation.test.ts`, GUI breakpoint 확인 |
| 종료/idle | timer/listener 정리, 닫은 surface에 stale update 없음, 이벤트 settle 후 refresh/sync 반복 없음 | 기존 refresh/watcher suite와 최소 60초 Extension Host idle 관찰 |
| source/layout | source bytes 불변, wrap/scroll/resize/font/zoom/split 변화에도 새 편집면에 의한 displacement 없음 | temporary source hash/bytes 비교 + 실제 GUI screenshot/recording |

수동 acceptance는 macOS에서 우선 수행하고 Windows/Linux 미검증 범위를 명시한다. light/dark/high-contrast와 keyboard-only, screen reader 접근성, blank anchor, 긴 줄, focus return을 기록한다. 필요한 항목을 관찰하지 못하면 unchecked로 둔다.

## 8. 검증 명령과 PR 전달

extension 디렉터리에서 실제 존재하는 scripts를 사용한다. 현재 `compile`/`package`의 `check`는 두 TypeScript 검사와 ESLint를 포함한다. `format:check` script는 없으므로 만들거나 실행했다고 기록하지 않는다.

```bash
npm ci
npm run check-types
npm run check-types:ts6
npm run lint
npm test
npm run package
```

`npm test`의 pretest가 tests compilation과 extension compilation을 실행한다. macOS Electron `SIGABRT`는 환경/코드 원인을 구분하고, Linux는 repository CI처럼 필요한 display 환경을 사용한다. 최소 버전/current stable 실행 방법은 설치한 `@vscode/test-cli`의 실제 옵션/config를 확인한 뒤 정한다.

Rust/Core/CLI를 수정하는 경우 아래 workspace 검증을 모두 실행한다. PR template의 필수 Rust 체크도 실제 실행하거나 이유와 함께 미실행으로 표시한다. 문서/PoC 전용 전달에서 불필요한 release build를 요구하지 않는다.

```bash
cargo check --workspace --all-features
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
git diff --check
```

release-sensitive Rust 변경이면 `cargo build --workspace --release`도 추가한다. UI만 변경하는 경우 새 version/tag/Marketplace 배포를 범위에 넣지 않는다.

최종 diff는 이슈 요구사항과 한 목적만 포함해야 한다. 생성된 `out`, `dist`, `coverage`, `.vscode-test`, 임시 Vault, GUI 프로필, credentials는 commit하지 않는다. README/CHANGELOG에는 실제로 제공한 동작과 종료·복구 한계를 설명한다.

구현 요청을 이어받아 PR까지 진행하는 에이전트는 다음 전달 규칙을 따른다. 이 계획 작성 작업 자체는 commit/push/PR을 생성하지 않는다.

1. 의도한 파일만 stage하고 Conventional Commit으로 commit한다.
2. `origin`의 issue branch에 normal push한다. force push하지 않는다.
3. `.github/PULL_REQUEST_TEMPLATE.md`의 모든 구조·section을 유지하여 `FrilLab/frilvault:main`을 base로 PR을 작성한다. multiline body는 임시 파일에 써서 `--body-file`로 전달한다.
4. CI 또는 material UI/durability acceptance가 남았으면 Draft PR을 사용한다. feasibility-only/no-go이면 `Refs #243`와 maintainer가 선택해야 할 구체적인 대안을 적는다.
5. `Closes #243`는 agreed UI, autosave 또는 입증된 contingency, 실제 persistence/reopen, 수동 acceptance 증거까지 충족했을 때만 사용한다.
6. PR/checks를 확인하고 관련 실패를 해결한다. merge, 직접 issue close, release는 수행하지 않는다.

## 9. 다음 에이전트가 남길 결과

아래 항목을 feasibility 문서와 PR에 채우면 이후 에이전트가 추측 없이 이어갈 수 있다.

- 최신 base SHA와 작업 branch/commit, 확인한 선행 issue/PR 상태.
- PoC 사용 API, 최소/current stable 실행 버전·OS, 우선/fallback 각각의 입력 가능성 및 no-displacement 증거.
- 선택 UI 또는 no-go 이유, 대안 선택 사항, 실행 가능한 재현 순서와 screenshot/recording 위치.
- 고정 target/session identity, composition 처리, controlled/native close 및 reload/forced shutdown의 실제 보장 경계.
- 추가한 regression과 실제 Vault reopen 결과, 실패 주입/복구/conflict 결과, 60초 idle 관찰.
- PASS/FAIL/SKIPPED를 구분한 검증 명령과 미검증 GUI·플랫폼 항목.
- PR URL, `Refs` 또는 `Closes`를 선택한 근거와 남은 acceptance.

## 10. 공식 API 및 프로젝트 참고

- [VS Code DecorationRenderOptions](https://code.visualstudio.com/api/references/vscode-api#DecorationRenderOptions): rendering options 확인.
- [VS Code MarkdownString](https://code.visualstudio.com/api/references/vscode-api#MarkdownString): supported HTML subset과 command trust 확인.
- [VS Code InputBox](https://code.visualstudio.com/api/references/vscode-api#InputBox): 입력과 hide/change lifecycle 확인.
- [VS Code CommentThread](https://code.visualstudio.com/api/references/vscode-api#CommentThread): range-bound native comments 후보 확인.
- [VS Code Webview API guide](https://code.visualstudio.com/api/extension-guides/webview): panel 생성과 message/state/disposal의 경계 확인.
- [VS Code Extending Workbench](https://code.visualstudio.com/api/extension-capabilities/extending-workbench): stable workbench 확장 표면 확인.
- [Repository GitHub workflow](github-workflow.md), [Testing](testing.md), [Release process](RELEASES/PROCESS.md).

위 공식 API 링크는 2026-10-04 계획 단계에서 열람했다. 실행 증거와 버전별 API 지원 여부는 Phase 1에서 별도로 확정해야 한다.
