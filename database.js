import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'bookhunter.db');

const sqlite = sqlite3.verbose();
const db = new sqlite.Database(dbPath);

class DatabaseManager {
  init() {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          nickname TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          passwordHash TEXT NOT NULL,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS books (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          chunkCount INTEGER DEFAULT 0,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS preferences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER UNIQUE NOT NULL,
          genres TEXT DEFAULT '[]',
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      console.log('✓ База данных инициализирована');
    });
  }

  getUserById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }

  getUserByEmail(email) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }

  getUserByNickname(nickname) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE nickname = ?', [nickname], (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }

  createUser({ email, nickname, name, passwordHash }) {
    return new Promise((resolve, reject) => {
      const self = this;
      db.run(
        'INSERT INTO users (email, nickname, name, passwordHash) VALUES (?, ?, ?, ?)',
        [email, nickname, name, passwordHash],
        function(err) {
          if (err) reject(err);
          else {
            self.getUserById(this.lastID).then(resolve).catch(reject);
          }
        }
      );
    });
  }

  getUserBooks(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT id, userId, title, chunkCount, createdAt, updatedAt FROM books WHERE userId = ? ORDER BY createdAt DESC',
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  getBook(id, userId) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM books WHERE id = ? AND userId = ?',
        [id, userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        }
      );
    });
  }

  createBook({ userId, title, content }) {
    return new Promise((resolve, reject) => {
      const self = this;
      const chunkCount = content.split('\n\n').filter(c => c.trim()).length;
      db.run(
        'INSERT INTO books (userId, title, content, chunkCount) VALUES (?, ?, ?, ?)',
        [userId, title, content, chunkCount],
        function(err) {
          if (err) reject(err);
          else {
            self.getBook(this.lastID, userId).then(resolve).catch(reject);
          }
        }
      );
    });
  }

  deleteBook(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM books WHERE id = ? AND userId = ?',
        [id, userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  updateBook(id, userId, { title, content }) {
    return new Promise((resolve, reject) => {
      const chunkCount = content.split('\n\n').filter(c => c.trim()).length;
      db.run(
        'UPDATE books SET title = ?, content = ?, chunkCount = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND userId = ?',
        [title, content, chunkCount, id, userId],
        (err) => {
          if (err) reject(err);
          else {
            this.getBook(id, userId).then(resolve).catch(reject);
          }
        }
      );
    });
  }

  getUserPreferences(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM preferences WHERE userId = ?', [userId], (err, row) => {
        if (err) reject(err);
        else if (row) {
          try {
            row.genres = JSON.parse(row.genres || '[]');
            resolve(row);
          } catch {
            resolve({ ...row, genres: [] });
          }
        } else {
          db.run(
            'INSERT INTO preferences (userId, genres) VALUES (?, ?)',
            [userId, '[]'],
            (err) => {
              if (err) reject(err);
              else resolve({ userId, genres: [] });
            }
          );
        }
      });
    });
  }

  saveUserPreferences(userId, genres) {
    return new Promise((resolve, reject) => {
      const self = this;
      db.get('SELECT id FROM preferences WHERE userId = ?', [userId], (err, existing) => {
        if (err) reject(err);
        else if (existing) {
          db.run(
            'UPDATE preferences SET genres = ?, updatedAt = CURRENT_TIMESTAMP WHERE userId = ?',
            [JSON.stringify(genres), userId],
            (err) => {
              if (err) reject(err);
              else self.getUserPreferences(userId).then(resolve).catch(reject);
            }
          );
        } else {
          db.run(
            'INSERT INTO preferences (userId, genres) VALUES (?, ?)',
            [userId, JSON.stringify(genres)],
            (err) => {
              if (err) reject(err);
              else self.getUserPreferences(userId).then(resolve).catch(reject);
            }
          );
        }
      });
    });
  }

  getAllStats() {
    return new Promise((resolve) => {
      db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        const userCount = row?.count || 0;
        db.get('SELECT COUNT(*) as count FROM books', (err, row2) => {
          const bookCount = row2?.count || 0;
          resolve({ users: userCount, books: bookCount });
        });
      });
    });
  }

  clearAllData() {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('DELETE FROM books', (err) => {
          if (err) reject(err);
          else {
            db.run('DELETE FROM preferences', (err) => {
              if (err) reject(err);
              else {
                db.run('DELETE FROM users', (err) => {
                  if (err) reject(err);
                  else {
                    console.log('! Все данные очищены');
                    resolve();
                  }
                });
              }
            });
          }
        });
      });
    });
  }
}

export default new DatabaseManager();