# Калимат

Сайт для заучивания арабских слов: по 3 слова в день, интервальные повторы и недельный зачёт.

- `words.js` — словарь, сюда добавляются новые слова.
- `firebase-config.js` — настройки Firebase для общей таблицы (вход только по имени).
- `app.js`, `style.css`, `index.html` — сам сайт.

## Правила Firestore

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{id} {
      allow read, write: if true;
    }
  }
}
```
