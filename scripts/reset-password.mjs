import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCallback);

function usage(exitCode = 0) {
  console.log(`Uso:\n  node scripts/reset-password.mjs --email <correo> [--db <ruta>]\n\nEjemplos:\n  node scripts/reset-password.mjs --email "amigo@example.com"\n  node scripts/reset-password.mjs --email "amigo@example.com" --db "C:/www/luma/data/luma.sqlite"`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  let email = '';
  let dbPath = process.env.LUMA_REPORT_DB || '';

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') usage(0);
    if (value === '--email') {
      email = String(argv[index + 1] || '').trim().toLowerCase();
      index += 1;
      continue;
    }
    if (value === '--db') {
      dbPath = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    console.error(`Argumento desconocido: ${value}`);
    usage(1);
  }

  if (!email) {
    console.error('Debes indicar el email del usuario con --email.');
    usage(1);
  }

  if (!dbPath) {
    const deployed = path.resolve('C:/www/luma/data/luma.sqlite');
    const local = path.resolve('data/luma.sqlite');
    dbPath = existsSync(deployed) ? deployed : local;
  }

  return { email, dbPath: path.resolve(dbPath) };
}

function readSecret(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(new Error('Este comando necesita una terminal interactiva para introducir la contraseña de forma segura.'));
      return;
    }

    const previousRawMode = Boolean(stdin.isRaw);
    let value = '';
    let settled = false;

    const cleanup = () => {
      stdin.off('data', onData);
      try { stdin.setRawMode(previousRawMode); } catch { /* terminal already closing */ }
      stdin.pause();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (character >= ' ') {
          value += character;
          process.stdout.write('*');
        }
      }
    };

    process.stdout.write(label);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: Buffer.from(derived).toString('hex') };
}

const { email, dbPath } = parseArgs(process.argv.slice(2));

if (!existsSync(dbPath)) {
  console.error(`No existe la base de datos: ${dbPath}`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath);

try {
  const user = db.prepare('SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(?)').get(email);

  if (!user) {
    console.error(`No existe ningún usuario con el email: ${email}`);
    process.exitCode = 3;
  } else {
    console.log(`Usuario: ${user.name} <${user.email}>`);
    console.log(`Base: ${dbPath}`);

    const password = await readSecret('Nueva contraseña: ');
    if (password.length < 8) {
      console.error('La contraseña debe tener al menos 8 caracteres. No se hizo ningún cambio.');
      process.exitCode = 4;
    } else {
      const confirmation = await readSecret('Repite la contraseña: ');
      if (password !== confirmation) {
        console.error('Las contraseñas no coinciden. No se hizo ningún cambio.');
        process.exitCode = 5;
      } else {
        const passwordData = await hashPassword(password);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
            .run(passwordData.hash, passwordData.salt, user.id);
          const sessionResult = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
          db.exec('COMMIT');

          console.log('Contraseña actualizada correctamente.');
          console.log(`Sesiones cerradas: ${Number(sessionResult.changes || 0)}`);
          console.log('El usuario ya puede iniciar sesión con la nueva contraseña.');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
          throw error;
        }
      }
    }
  }
} finally {
  db.close();
}
