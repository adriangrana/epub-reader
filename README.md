# Luma · EPUB Reader

Aplicación web de lectura EPUB enfocada en una experiencia visual limpia, privada y agradable.

## Funcionalidades

- Importación de uno o varios archivos `.epub`.
- Biblioteca local con portada, título, autor, búsqueda y progreso.
- Persistencia de libros y posición de lectura en IndexedDB.
- Lector paginado con índice navegable y controles anterior/siguiente.
- Narración del contenido visible usando Web Speech API y las voces instaladas en el dispositivo.
- Selector de voz y velocidad de narración.
- Diseño responsive para escritorio, tablet y móvil.
- Sin backend: los libros no salen del navegador.

## Desarrollo

Requiere Node.js 20.19+ o 22.12+ (requisito de Vite 8).

```bash
npm install
npm run dev
```

La aplicación se abrirá en la URL que indique Vite (normalmente `http://localhost:5173`).

## Validación

```bash
npm run build
```

## Consideraciones

- Los EPUB protegidos con DRM no pueden abrirse en `epubjs`.
- La calidad y disponibilidad de narradores depende de las voces instaladas por el sistema/navegador.
- IndexedDB pertenece al navegador y perfil actuales; limpiar los datos del sitio elimina la biblioteca local.
