const TIMEZONE = "Europe/Simferopol";
const ACADEMIC_YEAR = "2026-2027";
const DUTY_START_DATE = "2026-09-02";
const DUTY_GENERATE_DAYS = 60;

/* =====================================================
   WORKER
===================================================== */

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
      console.error("WORKER ERROR:", error);
      return new Response("OK");
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledTasks(env));
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
  const text = (message.text || "").trim();

  if (
    message.chat &&
    (
      message.chat.type === "group" ||
      message.chat.type === "supergroup"
    )
  ) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO settings (key, value)
       VALUES ('group_chat_id', ?)`
    )
      .bind(String(message.chat.id))
      .run();
  }

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

  /*
     Если пользователь сейчас находится
     в процессе ввода ДЗ или расписания —
     обрабатываем его текст.
  */
  const handledInput = await handlePendingInput(
    message,
    telegramId,
    text,
    env
  );

  if (handledInput) return;

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
        `🆔 Твой Telegram ID:\n${telegramId}\n\n` +
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
  const data = query.data || "";

  await telegram("answerCallbackQuery", {
    callback_query_id: query.id
  }, env);

  if (data === "today") {
    await showToday(chatId, telegramId, env);
    return;
  }

  if (data === "schedule") {
    await showSchedule(chatId, env);
    return;
  }

  if (data.startsWith("day_")) {
    const day = Number(data.replace("day_", ""));
    await showScheduleDay(chatId, day, env);
    return;
  }

  if (data === "today_schedule") {
    await showToday(chatId, telegramId, env);
    return;
  }

  if (data === "current_lesson") {
    await showCurrentLesson(chatId, env);
    return;
  }

  if (data === "duty") {
    await showDuty(chatId, telegramId, env);
    return;
  }

  if (data === "homework") {
    await showHomeworkMenu(chatId, env);
    return;
  }

  if (data.startsWith("hw_")) {
    const type = data.replace("hw_", "");
    await showHomework(chatId, type, env);
    return;
  }

  if (data === "replacement") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `🔄 Попросить замену\n\n` +
        `Функция замены будет подключена следующим этапом.`,
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

  if (data === "back") {
    await showMainMenu(chatId, telegramId, env);
    return;
  }

  /* ---------------- ADMIN ---------------- */

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
    await showAdminSchedule(chatId, telegramId, env);
    return;
  }

  if (data === "admin_homework") {
    await showAdminHomework(chatId, telegramId, env);
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

  /* ---------------- ADMIN HOMEWORK ---------------- */

  if (data === "hw_admin_add") {
    await beginPendingInput(
      telegramId,
      "hw_add",
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `➕ Добавление ДЗ\n\n` +
        `Отправь одним сообщением в формате:\n\n` +
        `ДД.ММ.ГГГГ | Предмет | Текст задания\n\n` +
        `Например:\n` +
        `09.09.2026 | Математика | Решить номера 125–130`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  if (data === "hw_admin_list") {
    await showAdminHomeworkList(chatId, telegramId, env);
    return;
  }

  if (data.startsWith("hw_delete_")) {
    const id = Number(data.replace("hw_delete_", ""));
    await deleteHomework(chatId, telegramId, id, env);
    return;
  }

  /* ---------------- ADMIN SCHEDULE ---------------- */

  if (data === "sch_admin_menu") {
    await showAdminSchedule(chatId, telegramId, env);
    return;
  }

  if (data === "sch_admin_add") {
    await beginPendingInput(
      telegramId,
      "schedule_add",
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `➕ Добавление пары\n\n` +
        `Отправь:\n\n` +
        `ДД.ММ.ГГГГ | № | начало | конец | предмет | преподаватель | кабинет\n\n` +
        `Пример:\n` +
        `15.09.2026 | 2 | 09:30 | 10:20 | Математика | Пешкова А.В. | 6`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  if (data === "sch_admin_change") {
    await beginPendingInput(
      telegramId,
      "schedule_change",
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `✏️ Изменение пары\n\n` +
        `Отправь:\n\n` +
        `ДД.ММ.ГГГГ | № | начало | конец | предмет | преподаватель | кабинет\n\n` +
        `Например:\n` +
        `10.09.2026 | 2 | 09:30 | 10:20 | Физика | Иванов И.И. | 18`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  if (data === "sch_admin_delete") {
    await beginPendingInput(
      telegramId,
      "schedule_delete",
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `🗑 Удаление пары\n\n` +
        `Отправь дату и номер пары:\n\n` +
        `ДД.ММ.ГГГГ | №\n\n` +
        `Например:\n` +
        `10.09.2026 | 3`,
      reply_markup: backMenu()
    }, env);

    return;
  }
}


/* =====================================================
   TODAY
===================================================== */

async function showToday(chatId, telegramId, env) {
  const dateString = getLocalDate();
  const day = getDayOfWeek(dateString);

  if (day === 0 || day === 6) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `🏠 Сегодня выходной.\n\n` +
        `📅 ${formatDate(dateString)}`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⚡ Что сейчас?",
              callback_data: "current_lesson"
            }
          ],
          [
            {
              text: "◀️ Назад",
              callback_data: "back"
            }
          ]
        ]
      }
    }, env);

    return;
  }

  await showScheduleDay(
    chatId,
    day,
    env,
    dateString
  );
}


/* =====================================================
   SCHEDULE MENU
===================================================== */

async function showSchedule(chatId, env) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📅 Расписание\n\n` +
      `Выбери день:`,
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
          { text: "☀️ Сегодня", callback_data: "today_schedule" },
          { text: "⚡ Что сейчас?", callback_data: "current_lesson" }
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

async function showScheduleDay(
  chatId,
  day,
  env,
  specificDate = null
) {
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

  const result = await getScheduleForDate(
    specificDate,
    day,
    env
  );

  if (!result.length) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `📅 ${dayNames[day]}\n\n` +
        `Расписание не найдено.`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  let text =
    `📅 ${dayNames[day]}\n`;

  if (specificDate) {
    text += `📆 ${formatDate(specificDate)}\n`;
  }

  text += `\n`;

  for (const lesson of result) {
    text +=
      `${lesson.lesson_number}. ${lesson.start_time}–${lesson.end_time}\n` +
      `📚 ${lesson.subject}\n` +
      `👨‍🏫 ${lesson.teacher || "Не указан"}\n` +
      `🚪 ${lesson.room || "Не указан"}\n\n`;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "⚡ Что сейчас?",
            callback_data: "current_lesson"
          }
        ],
        [
          {
            text: "◀️ Назад",
            callback_data: "schedule"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   GET SCHEDULE FOR DATE
===================================================== */

async function getScheduleForDate(
  specificDate,
  day,
  env
) {
  const base = await env.DB.prepare(
    `SELECT
       lesson_number,
       start_time,
       end_time,
       subject,
       teacher,
       room
     FROM schedule
     WHERE day_of_week = ?
       AND academic_year = ?
     ORDER BY lesson_number`
  )
    .bind(day, ACADEMIC_YEAR)
    .all();

  const lessons = base.results || [];

  if (!specificDate) {
    return lessons;
  }

  const exceptions = await env.DB.prepare(
    `SELECT
       lesson_number,
       start_time,
       end_time,
       subject,
       teacher,
       room,
       action
     FROM schedule_exceptions
     WHERE lesson_date = ?
     ORDER BY lesson_number`
  )
    .bind(specificDate)
    .all();

  for (const exception of exceptions.results || []) {
    const index = lessons.findIndex(
      l => Number(l.lesson_number) === Number(exception.lesson_number)
    );

    if (exception.action === "delete") {
      if (index >= 0) {
        lessons.splice(index, 1);
      }
      continue;
    }

    const changed = {
      lesson_number: exception.lesson_number,
      start_time:
        exception.start_time ||
        (index >= 0 ? lessons[index].start_time : ""),
      end_time:
        exception.end_time ||
        (index >= 0 ? lessons[index].end_time : ""),
      subject:
        exception.subject ||
        (index >= 0 ? lessons[index].subject : ""),
      teacher:
        exception.teacher ||
        (index >= 0 ? lessons[index].teacher : ""),
      room:
        exception.room ||
        (index >= 0 ? lessons[index].room : "")
    };

    if (index >= 0) {
      lessons[index] = changed;
    } else {
      lessons.push(changed);
    }
  }

  lessons.sort(
    (a, b) =>
      Number(a.lesson_number) -
      Number(b.lesson_number)
  );

  return lessons;
}


/* =====================================================
   CURRENT LESSON
===================================================== */

async function showCurrentLesson(chatId, env) {
  const date = getLocalDate();
  const day = getDayOfWeek(date);

  if (day === 0 || day === 6) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `⚡ Сейчас занятий нет.\n\n` +
        `Сегодня выходной.`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  const time = getLocalTime();
  const currentMinutes =
    time.hour * 60 + time.minute;

  const lessons = await getScheduleForDate(
    date,
    day,
    env
  );

  let current = null;
  let next = null;

  for (const lesson of lessons) {
    const start = timeToMinutes(lesson.start_time);
    const end = timeToMinutes(lesson.end_time);

    if (
      currentMinutes >= start &&
      currentMinutes < end
    ) {
      current = lesson;
      break;
    }

    if (start > currentMinutes && !next) {
      next = lesson;
    }
  }

  let text = `⚡ Что сейчас?\n\n`;

  if (current) {
    text +=
      `🔴 Сейчас идёт ${current.lesson_number}-я пара\n\n` +
      `📚 ${current.subject}\n` +
      `👨‍🏫 ${current.teacher || "Не указан"}\n` +
      `🚪 ${current.room || "Не указан"}\n` +
      `⏰ ${current.start_time}–${current.end_time}`;
  } else if (next) {
    text +=
      `🟢 Сейчас перемена.\n\n` +
      `Следующая — ${next.lesson_number}-я пара\n` +
      `⏰ ${next.start_time}–${next.end_time}\n` +
      `📚 ${next.subject}\n` +
      `🚪 ${next.room || "Не указан"}`;
  } else {
    text += `🏠 На сегодня занятия уже закончились.`;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: backMenu()
  }, env);
}


/* =====================================================
   HOMEWORK MENU
===================================================== */

async function showHomeworkMenu(chatId, env) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📚 Домашнее задание\n\n` +
      `Выбери период:`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📅 Сегодня", callback_data: "hw_today" },
          { text: "➡️ Завтра", callback_data: "hw_tomorrow" }
        ],
        [
          { text: "📆 На неделю", callback_data: "hw_week" },
          { text: "📚 Все ДЗ", callback_data: "hw_all" }
        ],
        [
          { text: "◀️ Назад", callback_data: "back" }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   HOMEWORK
===================================================== */

async function showHomework(chatId, type, env) {
  const today = getLocalDate();

  let from = today;
  let to = today;
  let title = "📚 ДЗ на сегодня";

  if (type === "tomorrow") {
    from = addDays(today, 1);
    to = from;
    title = "📚 ДЗ на завтра";
  }

  if (type === "week") {
    from = today;
    to = addDays(today, 6);
    title = "📚 ДЗ на неделю";
  }

  if (type === "all") {
    from = "0000-01-01";
    to = "9999-12-31";
    title = "📚 Все ДЗ";
  }

  const result = await env.DB.prepare(
    `SELECT
       id,
       lesson_date,
       subject,
       text,
       lesson_number
     FROM homework
     WHERE lesson_date >= ?
       AND lesson_date <= ?
       AND is_archived = 0
     ORDER BY lesson_date ASC,
              COALESCE(lesson_number, 99) ASC,
              id ASC`
  )
    .bind(from, to)
    .all();

  if (!result.results.length) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `${title}\n\n` +
        `Пока заданий нет. 🎉`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  let text = `${title}\n\n`;

  let currentDate = "";

  for (const homework of result.results) {
    if (homework.lesson_date !== currentDate) {
      currentDate = homework.lesson_date;

      text +=
        `📅 ${formatDate(currentDate)}\n`;
    }

    text +=
      `📚 ${homework.subject}\n`;

    if (homework.lesson_number) {
      text +=
        `🔢 Пара №${homework.lesson_number}\n`;
    }

    text +=
      `📝 ${homework.text}\n\n`;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: backMenu()
  }, env);
}


/* =====================================================
   ADMIN
===================================================== */

async function isAdmin(telegramId, env) {
  const student = await env.DB.prepare(
    `SELECT role
     FROM students
     WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  return (
    student &&
    (
      student.role === "admin" ||
      student.role === "deputy"
    )
  );
}


async function showAdmin(chatId, telegramId, env) {
  if (!(await isAdmin(telegramId, env))) {
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
   ADMIN — HOMEWORK
===================================================== */

async function showAdminHomework(chatId, telegramId, env) {
  if (!(await isAdmin(telegramId, env))) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⛔ Нет доступа."
    }, env);

    return;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📚 Управление ДЗ\n\n` +
      `Выбери действие:`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "➕ Добавить ДЗ",
            callback_data: "hw_admin_add"
          }
        ],
        [
          {
            text: "📋 Список ДЗ",
            callback_data: "hw_admin_list"
          }
        ],
        [
          {
            text: "◀️ В админ-панель",
            callback_data: "admin"
          }
        ]
      ]
    }
  }, env);
}


async function showAdminHomeworkList(chatId, telegramId, env) {
  if (!(await isAdmin(telegramId, env))) return;

  const result = await env.DB.prepare(
    `SELECT
       id,
       lesson_date,
       subject,
       text,
       lesson_number
     FROM homework
     WHERE is_archived = 0
     ORDER BY lesson_date ASC, id ASC
     LIMIT 30`
  ).all();

  if (!result.results.length) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "📚 Активных заданий пока нет.",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "◀️ Назад",
              callback_data: "admin_homework"
            }
          ]
        ]
      }
    }, env);

    return;
  }

  let text = "📚 Активные ДЗ\n\n";

  const buttons = [];

  for (const hw of result.results) {
    text +=
      `🆔 ${hw.id}\n` +
      `📅 ${formatDate(hw.lesson_date)}\n` +
      `📚 ${hw.subject}\n` +
      `📝 ${hw.text}\n\n`;

    buttons.push([
      {
        text: `🗑 Удалить №${hw.id}`,
        callback_data: `hw_delete_${hw.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "◀️ Назад",
      callback_data: "admin_homework"
    }
  ]);

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: buttons
    }
  }, env);
}


async function deleteHomework(chatId, telegramId, id, env) {
  if (!(await isAdmin(telegramId, env))) return;

  await env.DB.prepare(
    `UPDATE homework
     SET is_archived = 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(id)
    .run();

  await telegram("sendMessage", {
    chat_id: chatId,
    text: `🗑 ДЗ №${id} убрано из активных заданий.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📋 Список ДЗ",
            callback_data: "hw_admin_list"
          }
        ],
        [
          {
            text: "◀️ В админ-панель",
            callback_data: "admin"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   ADMIN — SCHEDULE
===================================================== */

async function showAdminSchedule(chatId, telegramId, env) {
  if (!(await isAdmin(telegramId, env))) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⛔ Нет доступа."
    }, env);

    return;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📚 Управление расписанием\n\n` +
      `Изменения по конкретной дате записываются отдельно ` +
      `и не уничтожают основное расписание.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "➕ Добавить пару",
            callback_data: "sch_admin_add"
          }
        ],
        [
          {
            text: "✏️ Изменить пару",
            callback_data: "sch_admin_change"
          }
        ],
        [
          {
            text: "🗑 Удалить пару",
            callback_data: "sch_admin_delete"
          }
        ],
        [
          {
            text: "◀️ В админ-панель",
            callback_data: "admin"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   ADMIN — DUTIES
===================================================== */

async function showAdminDuties(chatId, telegramId, env) {
  if (!(await isAdmin(telegramId, env))) {
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
     LEFT JOIN students s1
       ON d.student1_id = s1.id
     LEFT JOIN students s2
       ON d.student2_id = s2.id
     ORDER BY d.duty_date ASC
     LIMIT 50`
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
          {
            text: "◀️ Назад",
            callback_data: "admin"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   ADMIN — STUDENTS
===================================================== */

async function showAdminStudents(chatId, telegramId, env) {
  if (!(await isAdmin(telegramId, env))) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⛔ Нет доступа."
    }, env);

    return;
  }

  const result = await env.DB.prepare(
    `SELECT
       full_name,
       username,
       role,
       telegram_id
     FROM students
     WHERE is_active = 1
     ORDER BY full_name`
  ).all();

  let text =
    `👥 Участники ПК-38\n\n` +
    `Количество: ${result.results.length}\n\n`;

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
          {
            text: "◀️ Назад",
            callback_data: "admin"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   PENDING INPUT
===================================================== */

async function beginPendingInput(
  telegramId,
  action,
  env
) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO settings
     (key, value)
     VALUES (?, ?)`
  )
    .bind(
      `pending_${telegramId}`,
      action
    )
    .run();
}


async function clearPendingInput(
  telegramId,
  env
) {
  await env.DB.prepare(
    `DELETE FROM settings
     WHERE key = ?`
  )
    .bind(`pending_${telegramId}`)
    .run();
}


async function getPendingInput(
  telegramId,
  env
) {
  return await env.DB.prepare(
    `SELECT value
     FROM settings
     WHERE key = ?`
  )
    .bind(`pending_${telegramId}`)
    .first();
}


async function handlePendingInput(
  message,
  telegramId,
  text,
  env
) {
  const pending = await getPendingInput(
    telegramId,
    env
  );

  if (!pending) return false;

  const action = pending.value;

  if (action === "hw_add") {
    await processHomeworkAdd(
      message.chat.id,
      telegramId,
      text,
      env
    );

    return true;
  }

  if (
    action === "schedule_add" ||
    action === "schedule_change"
  ) {
    await processScheduleChange(
      message.chat.id,
      telegramId,
      text,
      env,
      action
    );

    return true;
  }

  if (action === "schedule_delete") {
    await processScheduleDelete(
      message.chat.id,
      telegramId,
      text,
      env
    );

    return true;
  }

  return false;
}


/* =====================================================
   PROCESS HOMEWORK ADD
===================================================== */

async function processHomeworkAdd(
  chatId,
  telegramId,
  text,
  env
) {
  if (!(await isAdmin(telegramId, env))) {
    await clearPendingInput(telegramId, env);
    return;
  }

  const parts = text.split("|").map(
    x => x.trim()
  );

  if (parts.length < 3) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❗ Неверный формат.\n\n` +
        `Используй:\n` +
        `ДД.ММ.ГГГГ | Предмет | Текст задания`
    }, env);

    return;
  }

  const date = parseRussianDate(parts[0]);
  const subject = parts[1];
  const homeworkText = parts.slice(2).join(" | ");

  if (!date || !subject || !homeworkText) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "❗ Не удалось разобрать данные. Проверь формат."
    }, env);

    return;
  }

  await env.DB.prepare(
    `INSERT INTO homework
     (lesson_date, subject, text, added_by)
     VALUES (?, ?, ?, ?)`
  )
    .bind(
      date,
      subject,
      homeworkText,
      telegramId
    )
    .run();

  await clearPendingInput(
    telegramId,
    env
  );

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `✅ ДЗ добавлено!\n\n` +
      `📅 ${formatDate(date)}\n` +
      `📚 ${subject}\n` +
      `📝 ${homeworkText}`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📚 Управление ДЗ",
            callback_data: "admin_homework"
          }
        ],
        [
          {
            text: "◀️ В админ-панель",
            callback_data: "admin"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   PROCESS SCHEDULE ADD / CHANGE
===================================================== */

async function processScheduleChange(
  chatId,
  telegramId,
  text,
  env,
  action
) {
  if (!(await isAdmin(telegramId, env))) {
    await clearPendingInput(telegramId, env);
    return;
  }

  const parts = text.split("|").map(
    x => x.trim()
  );

  if (parts.length < 7) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❗ Неверный формат.\n\n` +
        `Нужно:\n` +
        `ДД.ММ.ГГГГ | № | начало | конец | предмет | преподаватель | кабинет`
    }, env);

    return;
  }

  const date = parseRussianDate(parts[0]);
  const lessonNumber = Number(parts[1]);
  const startTime = parts[2];
  const endTime = parts[3];
  const subject = parts[4];
  const teacher = parts[5];
  const room = parts[6];

  if (
    !date ||
    !Number.isInteger(lessonNumber) ||
    lessonNumber < 1 ||
    lessonNumber > 20 ||
    !isValidTime(startTime) ||
    !isValidTime(endTime) ||
    !subject
  ) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❗ Проверь данные.\n\n` +
        `Номер пары: 1–20\n` +
        `Время: ЧЧ:ММ`
    }, env);

    return;
  }

  await env.DB.prepare(
    `INSERT OR REPLACE INTO schedule_exceptions
     (
       lesson_date,
       lesson_number,
       start_time,
       end_time,
       subject,
       teacher,
       room,
       action,
       created_by
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 'replace', ?)`
  )
    .bind(
      date,
      lessonNumber,
      startTime,
      endTime,
      subject,
      teacher || null,
      room || null,
      telegramId
    )
    .run();

  await clearPendingInput(
    telegramId,
    env
  );

  const verb =
    action === "schedule_add"
      ? "добавлена"
      : "изменена";

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `✅ Пара ${verb}!\n\n` +
      `📅 ${formatDate(date)}\n` +
      `🔢 Пара №${lessonNumber}\n` +
      `⏰ ${startTime}–${endTime}\n` +
      `📚 ${subject}\n` +
      `👨‍🏫 ${teacher || "Не указан"}\n` +
      `🚪 ${room || "Не указан"}`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📚 Расписание",
            callback_data: "admin_schedule"
          }
        ],
        [
          {
            text: "◀️ В админ-панель",
            callback_data: "admin"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   PROCESS SCHEDULE DELETE
===================================================== */

async function processScheduleDelete(
  chatId,
  telegramId,
  text,
  env
) {
  if (!(await isAdmin(telegramId, env))) {
    await clearPendingInput(telegramId, env);
    return;
  }

  const parts = text.split("|").map(
    x => x.trim()
  );

  if (parts.length < 2) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❗ Формат:\n\n` +
        `ДД.ММ.ГГГГ | №`
    }, env);

    return;
  }

  const date = parseRussianDate(parts[0]);
  const lessonNumber = Number(parts[1]);

  if (
    !date ||
    !Number.isInteger(lessonNumber)
  ) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "❗ Проверь дату и номер пары."
    }, env);

    return;
  }

  await env.DB.prepare(
    `INSERT OR REPLACE INTO schedule_exceptions
     (
       lesson_date,
       lesson_number,
       start_time,
       end_time,
       subject,
       teacher,
       room,
       action,
       created_by
     )
     VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, 'delete', ?)`
  )
    .bind(
      date,
      lessonNumber,
      telegramId
    )
    .run();

  await clearPendingInput(
    telegramId,
    env
  );

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `✅ Пара удалена с этого дня.\n\n` +
      `📅 ${formatDate(date)}\n` +
      `🔢 Пара №${lessonNumber}`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📚 Управление расписанием",
            callback_data: "admin_schedule"
          }
        ],
        [
          {
            text: "◀️ В админ-панель",
            callback_data: "admin"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   PLACEHOLDER
===================================================== */

async function adminPlaceholder(
  chatId,
  title,
  env
) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `${title}\n\n` +
      `Этот раздел пока находится в разработке.\n\n` +
      `Мы подключим его следующим этапом.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "◀️ В админ-панель",
            callback_data: "admin"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   DUTY — STUDENT
===================================================== */

async function showDuty(
  chatId,
  telegramId,
  env
) {
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

  const today = getLocalDate();

  const duty = await env.DB.prepare(
    `SELECT
        d.id,
        d.duty_date,
        d.pair_number,
        d.status,
        s1.full_name AS student1,
        s2.full_name AS student2
     FROM duties d
     LEFT JOIN students s1
       ON d.student1_id = s1.id
     LEFT JOIN students s2
       ON d.student2_id = s2.id
     WHERE
       (d.student1_id = ? OR d.student2_id = ?)
       AND d.status != 'cancelled'
       AND d.duty_date >= ?
     ORDER BY d.duty_date ASC
     LIMIT 1`
  )
    .bind(
      student.id,
      student.id,
      today
    )
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
    `👤 ${duty.student1 || "—"}\n` +
    `👤 ${duty.student2 || "—"}`;

  const history = await env.DB.prepare(
    `SELECT
       old_student_id,
       new_student_id,
       reason
     FROM duty_history
     WHERE duty_id = ?
     ORDER BY changed_at DESC
     LIMIT 1`
  )
    .bind(duty.id)
    .first();

  if (history) {
    const oldStudent = await env.DB.prepare(
      `SELECT full_name
       FROM students
       WHERE id = ?`
    )
      .bind(history.old_student_id)
      .first();

    const newStudent = await env.DB.prepare(
      `SELECT full_name
       FROM students
       WHERE id = ?`
    )
      .bind(history.new_student_id)
      .first();

    text +=
      `\n\n🔄 На эту дату действует замена:\n` +
      `${oldStudent?.full_name || "—"} → ` +
      `${newStudent?.full_name || "—"}`;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🔄 Попросить замену",
            callback_data: "replacement"
          }
        ],
        [
          {
            text: "◀️ Назад",
            callback_data: "back"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   AUTOMATIC DUTIES
===================================================== */

async function generateDuties(env) {
  const pairs = await env.DB.prepare(
    `SELECT
       pair_number,
       student1_id,
       student2_id
     FROM duty_pairs
     WHERE active = 1
     ORDER BY pair_number`
  ).all();

  if (!pairs.results.length) {
    console.error("No active duty pairs found");
    return;
  }

  const lastDuty = await env.DB.prepare(
    `SELECT
       duty_date,
       pair_number
     FROM duties
     ORDER BY duty_date DESC
     LIMIT 1`
  ).first();

  let currentDate;
  let nextPairNumber;

  if (lastDuty) {
    currentDate = addDays(
      lastDuty.duty_date,
      1
    );

    nextPairNumber =
      Number(lastDuty.pair_number) + 1;

    if (
      nextPairNumber >
      pairs.results.length
    ) {
      nextPairNumber = 1;
    }
  } else {
    currentDate = DUTY_START_DATE;
    nextPairNumber = 1;
  }

  const today = getLocalDate();

  const generationEnd = addDays(
    today > currentDate
      ? today
      : currentDate,
    DUTY_GENERATE_DAYS
  );

  let generated = 0;

  while (currentDate <= generationEnd) {
    const day = getDayOfWeek(currentDate);

    if (day !== 0 && day !== 6) {
      const calendar = await env.DB.prepare(
        `SELECT status
         FROM calendar
         WHERE calendar_date = ?`
      )
        .bind(currentDate)
        .first();

      const isCalendarDayOff =
        calendar &&
        (
          calendar.status === "holiday" ||
          calendar.status === "vacation" ||
          calendar.status === "cancelled" ||
          calendar.status === "weekend" ||
          calendar.status === "day_off"
        );

      if (!isCalendarDayOff) {
        const existing = await env.DB.prepare(
          `SELECT id
           FROM duties
           WHERE duty_date = ?`
        )
          .bind(currentDate)
          .first();

        if (!existing) {
          const pair =
            pairs.results.find(
              p =>
                Number(p.pair_number) ===
                nextPairNumber
            );

          if (pair) {
            await env.DB.prepare(
              `INSERT INTO duties
               (
                 duty_date,
                 pair_number,
                 student1_id,
                 student2_id,
                 status
               )
               VALUES (?, ?, ?, ?, 'scheduled')`
            )
              .bind(
                currentDate,
                pair.pair_number,
                pair.student1_id,
                pair.student2_id
              )
              .run();

            generated++;

            nextPairNumber++;

            if (
              nextPairNumber >
              pairs.results.length
            ) {
              nextPairNumber = 1;
            }
          }
        }
      }
    }

    currentDate = addDays(
      currentDate,
      1
    );
  }

  console.log(
    `Duties generated: ${generated}`
  );
}


/* =====================================================
   TODAY'S DUTY
===================================================== */

async function getTodayDuty(env) {
  const today = getLocalDate();

  return await env.DB.prepare(
    `SELECT
       d.id,
       d.duty_date,
       d.pair_number,
       d.student1_id,
       d.student2_id,
       d.status,
       s1.full_name AS student1,
       s2.full_name AS student2
     FROM duties d
     LEFT JOIN students s1
       ON d.student1_id = s1.id
     LEFT JOIN students s2
       ON d.student2_id = s2.id
     WHERE d.duty_date = ?
       AND d.status != 'cancelled'
     LIMIT 1`
  )
    .bind(today)
    .first();
}


/* =====================================================
   DUTY NOTIFICATIONS
===================================================== */

async function sendDutyNotification(
  env,
  type
) {
  const setting = await env.DB.prepare(
    `SELECT value
     FROM settings
     WHERE key = 'group_chat_id'`
  ).first();

  if (!setting || !setting.value) {
    console.log(
      "Group chat ID not saved yet"
    );
    return false;
  }

  const duty = await getTodayDuty(env);

  if (!duty) {
    console.log("No duty today");
    return false;
  }

  const today = getLocalDate();

  const history = await env.DB.prepare(
    `SELECT
       old_student_id,
       new_student_id
     FROM duty_history
     WHERE duty_id = ?
     ORDER BY changed_at DESC
     LIMIT 1`
  )
    .bind(duty.id)
    .first();

  let student1 = duty.student1;
  let student2 = duty.student2;
  let replacementText = "";

  if (history) {
    const oldStudent = await env.DB.prepare(
      `SELECT full_name
       FROM students
       WHERE id = ?`
    )
      .bind(history.old_student_id)
      .first();

    const newStudent = await env.DB.prepare(
      `SELECT full_name
       FROM students
       WHERE id = ?`
    )
      .bind(history.new_student_id)
      .first();

    if (oldStudent && newStudent) {
      if (
        student1 === oldStudent.full_name
      ) {
        student1 =
          newStudent.full_name;
      }

      if (
        student2 === oldStudent.full_name
      ) {
        student2 =
          newStudent.full_name;
      }

      replacementText =
        `\n\n🔄 Замена:\n` +
        `${oldStudent.full_name} → ` +
        `${newStudent.full_name}`;
    }
  }

  let text;

  if (type === "morning") {
    text =
      `☀️ ДОБРОЕ УТРО, ПК-38!\n\n` +
      `🧹 Сегодня дежурят:\n\n` +
      `👤 ${student1 || "—"}\n` +
      `👤 ${student2 || "—"}\n\n` +
      `📅 ${formatDate(today)}` +
      replacementText;
  } else {
    text =
      `⏰ НАПОМИНАНИЕ О ДЕЖУРСТВЕ\n\n` +
      `Сегодня дежурят:\n\n` +
      `👤 ${student1 || "—"}\n` +
      `👤 ${student2 || "—"}\n\n` +
      `Не забудьте выполнить дежурство после занятий.` +
      replacementText;
  }

  const result = await telegram(
    "sendMessage",
    {
      chat_id: setting.value,
      text
    },
    env
  );

  if (!result.ok) {
    console.error(
      "Telegram notification error:",
      result
    );

    return false;
  }

  return true;
}


/* =====================================================
   SCHEDULED TASKS
===================================================== */

async function runScheduledTasks(env) {
  try {
    await generateDuties(env);

    const now = getLocalTime();
    const today = getLocalDate();

    /* 07:00 */

    if (
      now.hour === 7 &&
      now.minute === 0
    ) {
      const enabled =
        await getSetting(
          "morning_message_enabled",
          env
        );

      if (enabled !== "0") {
        const key =
          "last_morning_notification";

        const setting =
          await env.DB.prepare(
            `SELECT value
             FROM settings
             WHERE key = ?`
          )
            .bind(key)
            .first();

        if (
          !setting ||
          setting.value !== today
        ) {
          const sent =
            await sendDutyNotification(
              env,
              "morning"
            );

          if (sent) {
            await env.DB.prepare(
              `INSERT OR REPLACE INTO settings
               (key, value)
               VALUES (?, ?)`
            )
              .bind(key, today)
              .run();
          }
        }
      }
    }

    /* 12:00 */

    if (
      now.hour === 12 &&
      now.minute === 0
    ) {
      const enabled =
        await getSetting(
          "duty_reminder_enabled",
          env
        );

      if (enabled !== "0") {
        const key =
          "last_duty_reminder";

        const setting =
          await env.DB.prepare(
            `SELECT value
             FROM settings
             WHERE key = ?`
          )
            .bind(key)
            .first();

        if (
          !setting ||
          setting.value !== today
        ) {
          const sent =
            await sendDutyNotification(
              env,
              "reminder"
            );

          if (sent) {
            await env.DB.prepare(
              `INSERT OR REPLACE INTO settings
               (key, value)
               VALUES (?, ?)`
            )
              .bind(key, today)
              .run();
          }
        }
      }
    }

  } catch (error) {
    console.error(
      "SCHEDULED TASK ERROR:",
      error
    );
  }
}


/* =====================================================
   SETTINGS
===================================================== */

async function getSetting(
  key,
  env
) {
  const result =
    await env.DB.prepare(
      `SELECT value
       FROM settings
       WHERE key = ?`
    )
      .bind(key)
      .first();

  return result?.value || null;
}


/* =====================================================
   DATE / TIME
===================================================== */

function getLocalDate() {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(new Date());

  const year =
    parts.find(
      p => p.type === "year"
    ).value;

  const month =
    parts.find(
      p => p.type === "month"
    ).value;

  const day =
    parts.find(
      p => p.type === "day"
    ).value;

  return `${year}-${month}-${day}`;
}


function getLocalTime() {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }
    ).formatToParts(new Date());

  let hour =
    Number(
      parts.find(
        p => p.type === "hour"
      ).value
    );

  const minute =
    Number(
      parts.find(
        p => p.type === "minute"
      ).value
    );

  if (hour === 24) {
    hour = 0;
  }

  return {
    hour,
    minute
  };
}


function getDayOfWeek(dateString) {
  const [
    year,
    month,
    day
  ] = dateString
    .split("-")
    .map(Number);

  return new Date(
    Date.UTC(
      year,
      month - 1,
      day
    )
  ).getUTCDay();
}


function addDays(
  dateString,
  days
) {
  const [
    year,
    month,
    day
  ] = dateString
    .split("-")
    .map(Number);

  const date =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day
      )
    );

  date.setUTCDate(
    date.getUTCDate() + days
  );

  return date
    .toISOString()
    .slice(0, 10);
}


function formatDate(date) {
  if (!date) return "";

  const parts =
    date.split("-");

  if (parts.length !== 3) {
    return date;
  }

  return (
    `${parts[2]}.` +
    `${parts[1]}.` +
    `${parts[0]}`
  );
}


function timeToMinutes(time) {
  if (!time) return 0;

  const parts =
    time.split(":")
      .map(Number);

  return (
    parts[0] * 60 +
    parts[1]
  );
}


function isValidTime(time) {
  return /^\d{2}:\d{2}$/.test(time);
}


function parseRussianDate(value) {
  if (!value) return null;

  const match =
    value.match(
      /^(\d{2})\.(\d{2})\.(\d{4})$/
    );

  if (!match) return null;

  const day = match[1];
  const month = match[2];
  const year = match[3];

  return `${year}-${month}-${day}`;
}


/* =====================================================
   BACK BUTTON
===================================================== */

function backMenu() {
  return {
    inline_keyboard: [
      [
        {
          text: "◀️ Назад",
          callback_data: "back"
        }
      ]
    ]
  };
}
