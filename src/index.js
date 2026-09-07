export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // Проверка Worker
      if (request.method === "GET") {
        return new Response("Помощник ПК-38 работает ✅");
      }

      // Только webhook
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
      console.error("WORKER ERROR:", error);
      return new Response("OK");
    }
  }
};


/* =====================================================
   TELEGRAM
===================================================== */

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


/* =====================================================
   MESSAGE
===================================================== */

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


/* =====================================================
   START
===================================================== */

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

  await sendMainMenu(message.chat.id, student, env);
}


/* =====================================================
   MAIN MENU
===================================================== */

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

  await sendMainMenu(chatId, student, env);
}


async function sendMainMenu(chatId, student, env) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `🏠 Главное меню\n\n` +
      `Привет, ${student.full_name}!`,
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


/* =====================================================
   CALLBACKS
===================================================== */

async function handleCallback(query, env) {
  if (!query.message) return;

  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const data = query.data;

  await telegram("answerCallbackQuery", {
    callback_query_id: query.id
  }, env);

  // Главное
  if (data === "today") {
    await showToday(chatId, telegramId, env);
    return;
  }

  // Расписание
  if (data === "schedule") {
    await showSchedule(chatId, env);
    return;
  }

  if (data.startsWith("day_")) {
    const day = Number(data.replace("day_", ""));
    await showScheduleDay(chatId, day, env);
    return;
  }

  // Дежурство
  if (data === "duty") {
    await showDuty(chatId, telegramId, env);
    return;
  }

  // Заглушки следующих разделов
  if (data === "homework") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "📚 Раздел ДЗ подключим следующим этапом.",
      reply_markup: backMenu()
    }, env);
    return;
  }

  if (data === "replacement") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `🔄 Попросить замену\n\n` +
        `Функция будет подключена следующим этапом.`,
      reply_markup: backMenu()
    }, env);
    return;
  }

  if (data === "late") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `⏰ Я опоздаю\n\n` +
        `Функция уведомления об опоздании будет подключена следующим этапом.`,
      reply_markup: backMenu()
    }, env);
    return;
  }

  if (data === "stats") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `📊 Моя статистика\n\n` +
        `Статистика будет подключена следующим этапом.`,
      reply_markup: backMenu()
    }, env);
    return;
  }

  if (data === "announcements") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `📢 Объявления\n\n` +
        `Пока опубликованных объявлений нет.`,
      reply_markup: backMenu()
    }, env);
    return;
  }

  // Назад
  if (data === "back") {
    await showMainMenu(chatId, telegramId, env);
    return;
  }

  // Админ
  if (data === "admin") {
    await showAdmin(chatId, telegramId, env);
    return;
  }

  if (data === "admin_duties") {
    await showAdminDuties(chatId, telegramId, env);
    return;
  }

  if (data === "admin_students") {
    await showAdminStudents(chatId, telegramId, env);
    return;
  }

  if (data === "admin_calendar") {
    await adminPlaceholder(chatId, "📅 Календарь", env);
    return;
  }

  if (data === "admin_schedule") {
    await adminPlaceholder(chatId, "📚 Управление расписанием", env);
    return;
  }

  if (data === "admin_homework") {
    await adminPlaceholder(chatId, "📚 Управление ДЗ", env);
    return;
  }

  if (data === "admin_announcements") {
    await adminPlaceholder(chatId, "📢 Управление объявлениями", env);
    return;
  }

  if (data === "admin_attendance") {
    await adminPlaceholder(chatId, "🕐 Посещаемость", env);
    return;
  }

  if (data === "admin_replacements") {
    await adminPlaceholder(chatId, "🔄 Замены", env);
    return;
  }

  if (data === "admin_stats") {
    await adminPlaceholder(chatId, "📊 Статистика группы", env);
    return;
  }

  if (data === "admin_year") {
    await adminPlaceholder(chatId, "🎓 Учебный год", env);
    return;
  }

  if (data === "admin_settings") {
    await adminPlaceholder(chatId, "⚙️ Настройки", env);
    return;
  }

  if (data === "admin_backup") {
    await adminPlaceholder(chatId, "💾 Резервная копия", env);
    return;
  }
}


/* =====================================================
   TODAY
===================================================== */

async function showToday(chatId, telegramId, env) {
  const student = await env.DB.prepare(
    `SELECT * FROM students WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  const now = new Date();

  // Европа/Симферополь: определяем день недели
  const dateString = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Simferopol"
  }).format(now);

  const weekday = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Simferopol",
      weekday: "numeric"
    }).format(now)
  );

  // JS getDay() через локальную дату
  const localDate = new Date(`${dateString}T12:00:00`);
  const day = localDate.getDay();

  if (day === 0 || day === 6) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `🏠 Сегодня выходной.\n\n📅 ${formatDate(dateString)}`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  await showScheduleDay(chatId, day, env, dateString, student);
}


/* =====================================================
   SCHEDULE MENU
===================================================== */

async function showSchedule(chatId, env) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "📅 Расписание\n\nВыбери день:",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Понедельник", callback_data: "day_1" },
          { text: "Вторник", callback_data: "day_2" }
        ],
        [
          { text: "Среда", callback_data: "day_3" },
          { text: "Четверг", callback_data: "day_4" }
        ],
        [
          { text: "Пятница", callback_data: "day_5" }
        ],
        [
          { text: "☀️ Сегодня", callback_data: "today" }
        ],
        [
          { text: "◀️ Назад", callback_data: "back" }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   SCHEDULE DAY
===================================================== */

async function showScheduleDay(chatId, day, env, specificDate = null) {
  const dayNames = {
    1: "Понедельник",
    2: "Вторник",
    3: "Среда",
    4: "Четверг",
    5: "Пятница"
  };

  if (!dayNames[day]) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "❗ Расписание для этого дня недоступно.",
      reply_markup: backMenu()
    }, env);

    return;
  }

  const result = await env.DB.prepare(
    `SELECT lesson_number,
            start_time,
            end_time,
            subject,
            teacher,
            room
     FROM schedule
     WHERE day_of_week = ?
       AND academic_year = '2026-2027'
     ORDER BY lesson_number`
  )
    .bind(day)
    .all();

  if (!result.results.length) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `📅 ${dayNames[day]}\n\n` +
        `Расписание не найдено.`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  let text = `📅 ${dayNames[day]}\n`;

  if (specificDate) {
    text += `📆 ${formatDate(specificDate)}\n`;
  }

  text += `\n`;

  for (const lesson of result.results) {
    text +=
      `${lesson.lesson_number}. ${lesson.start_time}–${lesson.end_time}\n` +
      `📚 ${lesson.subject}\n` +
      `👨‍🏫 ${lesson.teacher || "Не указан"}\n` +
      `🚪 ${lesson.room || "Не указан"}\n\n`;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: backMenu()
  }, env);
}


/* =====================================================
   DUTY — STUDENT
===================================================== */

async function showDuty(chatId, telegramId, env) {
  const student = await env.DB.prepare(
    `SELECT id, full_name
     FROM students
     WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  if (!student) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❗ Твой Telegram пока не привязан к группе.\n\n` +
        `Используй /id и передай ID старосте.`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  // Ищем ближайшее будущее дежурство
  const duty = await env.DB.prepare(
    `SELECT
        d.id,
        d.duty_date,
        d.pair_number,
        d.status,
        s1.full_name AS student1,
        s2.full_name AS student2
     FROM duties d
     LEFT JOIN students s1 ON d.student1_id = s1.id
     LEFT JOIN students s2 ON d.student2_id = s2.id
     WHERE (d.student1_id = ? OR d.student2_id = ?)
       AND d.status != 'cancelled'
       AND d.duty_date >= date('now', 'localtime')
     ORDER BY d.duty_date ASC
     LIMIT 1`
  )
    .bind(student.id, student.id)
    .first();

  if (!duty) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `🧹 Дежурство\n\n` +
        `Для тебя ближайшее дежурство пока не назначено.`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  let text =
    `🧹 Твоё ближайшее дежурство\n\n` +
    `📅 Дата: ${formatDate(duty.duty_date)}\n` +
    `👥 Пара №${duty.pair_number}\n\n` +
    `👤 ${duty.student1}\n` +
    `👤 ${duty.student2}`;

  if (duty.duty_date === "2026-09-07") {
    text += `\n\n🔄 На эту дату действует замена:\nФролов Никита → Хомченко Степан`;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔄 Попросить замену", callback_data: "replacement" }
        ],
        [
          { text: "◀️ Назад", callback_data: "back" }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   ADMIN
===================================================== */

async function showAdmin(chatId, telegramId, env) {
  const student = await env.DB.prepare(
    `SELECT role
     FROM students
     WHERE telegram_id = ?`
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
        ],
        [
          { text: "◀️ Назад", callback_data: "back" }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   ADMIN — DUTIES
===================================================== */

async function showAdminDuties(chatId, telegramId, env) {
  const admin = await env.DB.prepare(
    `SELECT role FROM students WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  if (!admin || (admin.role !== "admin" && admin.role !== "deputy")) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⛔ Нет доступа."
    }, env);

    return;
  }

  const result = await env.DB.prepare(
    `SELECT
        d.duty_date,
        d.pair_number,
        d.status,
        s1.full_name AS student1,
        s2.full_name AS student2
     FROM duties d
     LEFT JOIN students s1 ON d.student1_id = s1.id
     LEFT JOIN students s2 ON d.student2_id = s2.id
     ORDER BY d.duty_date ASC
     LIMIT 20`
  ).all();

  let text = "🧹 Дежурства\n\n";

  if (!result.results.length) {
    text += "Дежурства не найдены.";
  } else {
    for (const duty of result.results) {
      text +=
        `📅 ${formatDate(duty.duty_date)} — пара №${duty.pair_number}\n` +
        `👤 ${duty.student1 || "—"}\n` +
        `👤 ${duty.student2 || "—"}\n` +
        `Статус: ${duty.status}\n\n`;
    }
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "◀️ Назад", callback_data: "admin" }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   ADMIN — STUDENTS
===================================================== */

async function showAdminStudents(chatId, telegramId, env) {
  const admin = await env.DB.prepare(
    `SELECT role FROM students WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  if (!admin || (admin.role !== "admin" && admin.role !== "deputy")) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⛔ Нет доступа."
    }, env);

    return;
  }

  const result = await env.DB.prepare(
    `SELECT full_name, username, role, telegram_id
     FROM students
     WHERE is_active = 1
     ORDER BY full_name`
  ).all();

  let text = `👥 Участники ПК-38\n\nКоличество: ${result.results.length}\n\n`;

  for (const student of result.results) {
    const telegramStatus = student.telegram_id
      ? `🟢 ${student.telegram_id}`
      : "⚪ Telegram не привязан";

    text +=
      `👤 ${student.full_name}\n` +
      `🔹 ${student.username || "username нет"}\n` +
      `🔹 ${student.role}\n` +
      `${telegramStatus}\n\n`;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "◀️ Назад", callback_data: "admin" }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   PLACEHOLDER
===================================================== */

async function adminPlaceholder(chatId, title, env) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `${title}\n\n` +
      `Этот раздел пока находится в разработке.\n\n` +
      `Мы подключим его следующим этапом.`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "◀️ В админ-панель", callback_data: "admin" }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   BACK BUTTON
===================================================== */

function backMenu() {
  return {
    inline_keyboard: [
      [
        { text: "◀️ Назад", callback_data: "back" }
      ]
    ]
  };
}


/* =====================================================
   HELPERS
===================================================== */

function formatDate(date) {
  if (!date) return "";

  const parts = date.split("-");

  if (parts.length !== 3) return date;

  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}
