export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET") {
        return new Response("Помощник ПК-38 работает ✅");
      }

      if (url.pathname !== "/webhook") {
        return new Response("Not found", { status: 404 });
      }

      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const update = await request.json();

      if (update.message) {
        await handleMessage(update.message, env);
      }

      if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }

      return new Response("OK");
    } catch (error) {
      console.error(error);
      return new Response("OK");
    }
  }
};


/* =========================
   TELEGRAM
========================= */

async function telegram(method, data, env) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  return await response.json();
}


/* =========================
   MESSAGE
========================= */

async function handleMessage(message, env) {
  if (!message.from) return;

  const telegramId = message.from.id;
  const text = message.text || "";

  if (text === "/start") {
    await startCommand(message, env);
    return;
  }

  if (text === "/id") {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `🆔 Ваш Telegram ID:\n\n` +
        `${telegramId}\n\n` +
        `Имя: ${message.from.first_name || ""}`
    }, env);

    return;
  }

  await showMainMenu(message.chat.id, telegramId, env);
}


/* =========================
   START
========================= */

async function startCommand(message, env) {
  const telegramId = message.from.id;

  const student = await env.DB.prepare(
    `SELECT * FROM students WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  if (!student) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `👋 Привет!\n\n` +
        `Это тестовая версия «Помощника ПК-38».\n\n` +
        `🆔 Твой Telegram ID:\n` +
        `${telegramId}\n\n` +
        `Пока твой Telegram не привязан к списку группы.\n` +
        `Передай этот ID старосте.`
    }, env);

    return;
  }

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text:
      `👋 Привет, ${student.full_name}!\n\n` +
      `Добро пожаловать в «Помощник ПК-38».\n\n` +
      `Выбери нужный раздел 👇`,
    reply_markup: mainMenu(student.role)
  }, env);
}


/* =========================
   MAIN MENU
========================= */

async function showMainMenu(chatId, telegramId, env) {
  const student = await env.DB.prepare(
    `SELECT * FROM students WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  if (!student) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❗ Ты пока не привязан к группе.\n\n` +
        `Используй /id и передай ID старосте.`
    }, env);

    return;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text: "🏠 Главное меню",
    reply_markup: mainMenu(student.role)
  }, env);
}


function mainMenu(role) {
  const keyboard = [
    [
      { text: "☀️ Сегодня", callback_data: "today" },
      { text: "📅 Расписание", callback_data: "schedule" }
    ],
    [
      { text: "📚 ДЗ", callback_data: "homework" },
      { text: "🧹 Дежурство", callback_data: "duty" }
    ],
    [
      { text: "🔄 Попросить замену", callback_data: "replacement" },
      { text: "⏰ Я опоздаю", callback_data: "late" }
    ],
    [
      { text: "📊 Моя статистика", callback_data: "stats" },
      { text: "📢 Объявления", callback_data: "announcements" }
    ]
  ];

  if (role === "admin" || role === "deputy") {
    keyboard.push([
      { text: "👑 Админ-панель", callback_data: "admin" }
    ]);
  }

  return {
    inline_keyboard: keyboard
  };
}


/* =========================
   CALLBACKS
========================= */

async function handleCallback(query, env) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const data = query.data;

  await telegram("answerCallbackQuery", {
    callback_query_id: query.id
  }, env);

  if (data === "today") {
    await showToday(chatId, telegramId, env);
    return;
  }

  if (data === "schedule") {
    await showSchedule(chatId, telegramId, env);
    return;
  }

  if (data === "duty") {
    await showDuty(chatId, telegramId, env);
    return;
  }

  if (data === "homework") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "📚 Раздел домашнего задания пока находится в разработке."
    }, env);
    return;
  }

  if (data === "replacement") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "🔄 Раздел замен будет подключён следующим этапом."
    }, env);
    return;
  }

  if (data === "late") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⏰ Напиши, во сколько примерно придёшь."
    }, env);
    return;
  }

  if (data === "stats") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "📊 Твоя статистика пока формируется."
    }, env);
    return;
  }

  if (data === "announcements") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "📢 Пока объявлений нет."
    }, env);
    return;
  }

  if (data === "admin") {
    await showAdmin(chatId, telegramId, env);
    return;
  }
}


/* =========================
   TODAY
========================= */

async function showToday(chatId, telegramId, env) {
  const now = new Date();

  const weekday = now.getDay();

  if (weekday === 0 || weekday === 6) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "🏠 Сегодня выходной."
    }, env);

    return;
  }

  const day = weekday === 0 ? 7 : weekday;

  const result = await env.DB.prepare(
    `SELECT lesson_number, start_time, end_time,
            subject, teacher, room
     FROM schedule
     WHERE day_of_week = ?
     ORDER BY lesson_number`
  )
    .bind(day)
    .all();

  if (!result.results.length) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "📅 На сегодня расписание не найдено."
    }, env);

    return;
  }

  let text = "☀️ Сегодня\n\n";

  for (const lesson of result.results) {
    text +=
      `${lesson.lesson_number}. ` +
      `${lesson.start_time}–${lesson.end_time}\n` +
      `📚 ${lesson.subject}\n` +
      `👨‍🏫 ${lesson.teacher}\n` +
      `🚪 Кабинет: ${lesson.room}\n\n`;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text
  }, env);
}


/* =========================
   SCHEDULE
========================= */

async function showSchedule(chatId, telegramId, env) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "📅 Расписание",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "☀️ Сегодня", callback_data: "today" }
        ],
        [
          { text: "📅 Понедельник", callback_data: "day_1" },
          { text: "📅 Вторник", callback_data: "day_2" }
        ],
        [
          { text: "📅 Среда", callback_data: "day_3" },
          { text: "📅 Четверг", callback_data: "day_4" }
        ],
        [
          { text: "📅 Пятница", callback_data: "day_5" }
        ]
      ]
    }
  }, env);
}


/* =========================
   DUTY
========================= */

async function showDuty(chatId, telegramId, env) {
  const student = await env.DB.prepare(
    `SELECT id, full_name FROM students WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  if (!student) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "❗ Твой Telegram пока не привязан."
    }, env);

    return;
  }

  const duty = await env.DB.prepare(
    `SELECT d.duty_date,
            d.pair_number,
            s1.full_name AS student1,
            s2.full_name AS student2
     FROM duties d
     LEFT JOIN students s1 ON d.student1_id = s1.id
     LEFT JOIN students s2 ON d.student2_id = s2.id
     WHERE d.student1_id = ?
        OR d.student2_id = ?
     ORDER BY d.duty_date DESC
     LIMIT 1`
  )
    .bind(student.id, student.id)
    .first();

  if (!duty) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "🧹 Для тебя дежурство пока не найдено."
    }, env);

    return;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `🧹 Твоё дежурство\n\n` +
      `📅 Дата: ${duty.duty_date}\n` +
      `👥 Пара №${duty.pair_number}\n\n` +
      `${duty.student1}\n` +
      `${duty.student2}`
  }, env);
}


/* =========================
   ADMIN
========================= */

async function showAdmin(chatId, telegramId, env) {
  const student = await env.DB.prepare(
    `SELECT role FROM students WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  if (!student || (student.role !== "admin" && student.role !== "deputy")) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⛔ У тебя нет доступа к админ-панели."
    }, env);

    return;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text: "👑 Админ-панель",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🧹 Дежурства", callback_data: "admin_duties" },
          { text: "📅 Календарь", callback_data: "admin_calendar" }
        ],
        [
          { text: "📚 Расписание", callback_data: "admin_schedule" },
          { text: "📚 ДЗ", callback_data: "admin_homework" }
        ],
        [
          { text: "📢 Объявления", callback_data: "admin_announcements" },
          { text: "🕐 Посещаемость", callback_data: "admin_attendance" }
        ],
        [
          { text: "🔄 Замены", callback_data: "admin_replacements" },
          { text: "📊 Статистика", callback_data: "admin_stats" }
        ],
        [
          { text: "👥 Участники", callback_data: "admin_students" }
        ],
        [
          { text: "🎓 Учебный год", callback_data: "admin_year" },
          { text: "⚙️ Настройки", callback_data: "admin_settings" }
        ],
        [
          { text: "💾 Резервная копия", callback_data: "admin_backup" }
        ]
      ]
    }
  }, env);
}
