# Security / 보안

## Reporting a problem

Please **do not** open a public issue for a security problem.
Use **Security → Report a vulnerability** on this repository instead. Only the maintainer can see the report.

Please include:

- The Claude Pet version and your OS
- What can happen and how to reproduce it

Do not include your session titles, passwords, tokens or other private data.
This is a personal project, so a reply can take some days.

## Supported versions

Only the latest release gets fixes. A fix comes as a new release; published files are never replaced.

## Check your download

Download Claude Pet only from this repository's [Releases](../../releases) page.
The program is not code-signed, so compare the SHA-256 in the release notes before you run it:

```powershell
Get-FileHash .\ClaudePet-<version>-win-x64.zip
```

## What the program does

See the security section of the [README](README.md#what-it-does-security).
In short: it reads the Claude Code session history on your computer, adds hooks to `~/.claude/settings.json` (after a backup), and never connects to the internet.

---

## 보안 문제 알리기

보안 문제는 공개 이슈로 올리지 **마세요**. 이 저장소의 **Security → Report a vulnerability**로 알려 주세요. 관리자만 볼 수 있습니다.

버전과 운영체제, 무엇이 일어날 수 있는지와 재현 방법을 적어 주세요. 세션 제목, 비밀번호, 토큰 같은 개인 정보는 넣지 마세요.
개인 프로젝트라 답이 며칠 걸릴 수 있습니다.

최신 Release만 고칩니다. 고친 내용은 새 버전으로 올리고, 이미 올린 파일을 바꿔치기하지 않습니다.
프로그램은 이 저장소의 [Releases](../../releases)에서만 받고, Release에 적힌 SHA-256과 비교해 확인하세요.
