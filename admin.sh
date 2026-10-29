#!/bin/sh
# Scoreboard admin helper.  Usage:
#   ./admin.sh list                 show all entries (id, nick, score)
#   ./admin.sh delete <id>          remove one entry
#   ./admin.sh rename <id> <nick>   change a nickname
#   ./admin.sh reset                clear the board (a backup is saved in data/)
# Reads ADMIN_KEY and PORT from .env. Set URL=https://your-host/path to manage a remote server.
cd "$(dirname "$0")"
[ -f .env ] && . ./.env
URL="${URL:-http://localhost:${PORT:-8080}}"
[ -z "$ADMIN_KEY" ] && { echo "ADMIN_KEY is not set (see .env)"; exit 1; }
H="X-Admin-Key: $ADMIN_KEY"
case "$1" in
  list)   if command -v node >/dev/null 2>&1; then
            curl -fsS -H "$H" "$URL/api/admin/scores" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s))console.log(r.id.padEnd(22),String(r.score).padStart(5),"",r.nick)})'
          else curl -fsS -H "$H" "$URL/api/admin/scores"; echo; fi ;;
  delete) curl -fsS -X DELETE -H "$H" "$URL/api/admin/scores/$2"; echo ;;
  rename) curl -fsS -X PATCH -H "$H" -H "Content-Type: application/json" -d "{\"nick\":\"$3\"}" "$URL/api/admin/scores/$2"; echo ;;
  reset)  printf "Clear the whole scoreboard? Type yes: "; read a; [ "$a" = yes ] && curl -fsS -X POST -H "$H" "$URL/api/admin/reset"; echo ;;
  *) sed -n '2,8p' "$0" ;;
esac
