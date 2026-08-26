.PHONY: build deploy restart redeploy status logs tunnel-logs readers reset-password restore-book purge-book

DEPLOY_DIR := C:/www/luma

# Ejemplo: make build
build:
	npm run build

# Ejemplo: make deploy
deploy: build
	powershell -NoProfile -ExecutionPolicy Bypass -File "./scripts/deploy.ps1" -DeployDir "$(DEPLOY_DIR)"

# Ejemplo: make restart
restart:
	runara restart luma

# Ejemplo: make redeploy
redeploy: deploy

# Ejemplo: make status
status:
	runara info luma
	runara info luma-tunnel

# Ejemplo: make logs
logs:
	runara logs luma --lines 100

# Ejemplo: make tunnel-logs
tunnel-logs:
	runara logs luma-tunnel --lines 80
	runara logs luma-tunnel --err --lines 80

# Ejemplo: make readers BOOK="Marca"
# Por ID exacto: make readers ID="<book-id>"
readers:
	@node --no-warnings scripts/book-readers.mjs $(if $(BOOK),"$(BOOK)",) $(if $(ID),--id "$(ID)",) $(if $(DB),--db "$(DB)",)

# Ejemplo: make restore-book ID="<book-id>" VISIBILITY=public
restore-book:
	@node --no-warnings scripts/restore-book.mjs $(if $(ID),--id "$(ID)",) $(if $(VISIBILITY),--visibility "$(VISIBILITY)",) $(if $(DB),--db "$(DB)",)

# Ejemplo: make purge-book ID="<book-id>"
# Eliminación definitiva: make purge-book ID="<book-id>" CONFIRM=DELETE
purge-book:
	@node --no-warnings scripts/purge-book.mjs $(if $(ID),--id "$(ID)",) $(if $(CONFIRM),--confirm "$(CONFIRM)",) $(if $(DB),--db "$(DB)",)

# Ejemplo: make reset-password EMAIL="correo@ejemplo.com"
reset-password:
	@node --no-warnings scripts/reset-password.mjs $(if $(EMAIL),--email "$(EMAIL)",) $(if $(DB),--db "$(DB)",)
