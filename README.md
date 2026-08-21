# Luma

Luma es un lector EPUB web con biblioteca multiusuario, almacenamiento físico local, catálogo público, compartición entre usuarios y narración mediante las voces instaladas en el sistema.

## Funcionalidades

- Registro e inicio de sesión por usuario.
- Contraseñas derivadas con `scrypt`; nunca se almacenan en texto plano.
- Sesiones revocables almacenadas en SQLite mediante cookie `HttpOnly`.
- EPUB guardados físicamente en el equipo que ejecuta Luma.
- Deduplicación SHA-256: un EPUB idéntico se almacena una sola vez aunque esté en varias bibliotecas.
- Biblioteca personal independiente por usuario.
- Progreso de lectura independiente por usuario y libro.
- Libros privados o públicos.
- Biblioteca pública con opción **Añadir a mi biblioteca**.
- Compartición directa de un libro con otro usuario registrado por email.
- Bandeja **Compartidos conmigo** para leer, aceptar o descartar libros recibidos.
- Descarga del EPUB original desde la biblioteca personal.
- Lector paginado, índice navegable y página única en escritorio.
- Narración con Web Speech API, selector de voz y velocidad.

## Dónde se guardan los datos

Por defecto Luma crea automáticamente:

```text
data/
├── luma.sqlite
├── books/
│   └── <sha256>.epub
└── covers/
    └── <book-id>.<ext>
```

`data/` está excluido de Git y **no debe subirse al repositorio**.

Puedes cambiar la ubicación física con `LUMA_DATA_DIR`.

PowerShell:

```powershell
$env:LUMA_DATA_DIR="D:\LumaData"
npm run dev
```

En ese caso SQLite, EPUB y portadas se guardarán en `D:\LumaData`.

## Desarrollo

Requiere **Node.js 22.13+**.

```bash
npm install
npm run dev
```

Un solo comando levanta:

- Frontend Vite: `http://localhost:5173`
- API/servidor Luma: `http://localhost:8787`

Vite redirige automáticamente `/api` al servidor Luma durante desarrollo.

## Producción local

```bash
npm run build
npm start
```

Después del build, el servidor Node también sirve `dist/`.

## Modelo de datos

SQLite mantiene separadas las siguientes responsabilidades:

- `users`: cuentas.
- `sessions`: sesiones activas.
- `book_assets`: EPUB físicos deduplicados.
- `library_entries`: pertenencia y visibilidad de cada libro en cada biblioteca.
- `book_shares`: libros compartidos directamente entre usuarios.
- `reading_progress`: CFI y porcentaje por usuario/libro.

Un mismo `book_asset` puede aparecer en varias bibliotecas sin duplicar el archivo `.epub`.

## Privacidad y despliegue

En desarrollo los archivos permanecen en el PC que ejecuta el servidor Luma. Si varias personas acceden al mismo servidor, cada una ve únicamente su biblioteca, los libros públicos y los libros compartidos con ella.

Si Luma se publica posteriormente en Internet, el mismo modelo puede mantenerse y sustituir `data/books` por almacenamiento de objetos (S3, R2, MinIO, etc.). Para un despliegue remoto real debe usarse HTTPS y endurecer las políticas de sesión/CSRF.

## Consideraciones

- Los EPUB con DRM no pueden abrirse con `epubjs`.
- La calidad de la narración depende de las voces disponibles en el navegador/sistema operativo.
- Hacer público un libro permite que cualquier usuario registrado en ese servidor Luma lo lea y lo incorpore a su biblioteca; publica solo contenido que tengas derecho a compartir.
