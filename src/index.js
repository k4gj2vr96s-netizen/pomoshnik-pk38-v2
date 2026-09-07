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
  },


  /* ===================================================
     CRON
  =================================================== */

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
  const text = message.text || "";

  /*
     Если сообщение пришло из группы —
     автоматически запоминаем ID группы.
  */
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

  if (data === "duty") {
    await showDuty(chatId, telegramId, env);
    return;
  }

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

  if (data === "back") {
    await showMainMenu(chatId, telegramId, env);
    return;
  }

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

  const dateString = getLocalDate();

  const day = getDayOfWeek(dateString);

  if (day === 0 || day === 6) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `🏠 Сегодня выходной.\n\n` +
        `📅 ${formatDate(dateString)}`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  await showScheduleDay(
    chatId,
    day,
    env,
    dateString,
    student
  );
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

  const result = await env.DB.prepare(
    `SELECT lesson_number,
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
     LEFT JOIN students s1 ON d.student1_id = s1.id
     LEFT JOIN students s2 ON d.student2_id = s2.id
     WHERE (d.student1_id = ? OR d.student2_id = ?)
       AND d.status != 'cancelled'
       AND d.duty_date >= ?
     ORDER BY d.duty_date ASC
     LIMIT 1`
  )
    .bind(student.id, student.id, today)
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
      `SELECT full_name FROM students WHERE id = ?`
    )
      .bind(history.old_student_id)
      .first();

    const newStudent = await env.DB.prepare(
      `SELECT full_name FROM students WHERE id = ?`
    )
      .bind(history.new_student_id)
      .first();

    text +=
      `\n\n🔄 На эту дату действует замена:\n` +
      `${oldStudent?.full_name || "—"} → ${newStudent?.full_name || "—"}`;
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

  if (
    !student ||
    (student.role !== "admin" && student.role !== "deputy")
  ) {
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

  if (
    !admin ||
    (admin.role !== "admin" && admin.role !== "deputy")
  ) {
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

  if (
    !admin ||
    (admin.role !== "admin" && admin.role !== "deputy")
  ) {
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

  /*
     Смотрим последнюю уже созданную дату.
     Это позволяет продолжить очередь,
     а не начинать её заново.
  */
  const lastDuty = await env.DB.prepare(
    `SELECT duty_date, pair_number
     FROM duties
     ORDER BY duty_date DESC
     LIMIT 1`
  ).first();

  let currentDate;
  let nextPairNumber;

  if (lastDuty) {
    currentDate = addDays(lastDuty.duty_date, 1);

    nextPairNumber =
      Number(lastDuty.pair_number) + 1;

    if (nextPairNumber > pairs.results.length) {
      nextPairNumber = 1;
    }
  } else {
    currentDate = DUTY_START_DATE;
    nextPairNumber = 1;
  }

  const today = getLocalDate();

  /*
     Если база почему-то ещё пустая и стартовая дата
     уже прошла — всё равно начинаем со стартовой даты.
  */
  if (!lastDuty && currentDate < DUTY_START_DATE) {
    currentDate = DUTY_START_DATE;
  }

  /*
     Генерируем вперёд.
  */
  const generationEnd = addDays(
    today > currentDate ? today : currentDate,
    DUTY_GENERATE_DAYS
  );

  let generated = 0;

  while (currentDate <= generationEnd) {
    const day = getDayOfWeek(currentDate);

    // Суббота и воскресенье
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

        /*
           Если дежурство уже есть —
           ничего не меняем и очередь не двигаем.
        */
        if (!existing) {
          const pair = pairs.results.find(
            p => Number(p.pair_number) === nextPairNumber
          );

          if (pair) {
            await env.DB.prepare(
              `INSERT INTO duties
               (duty_date,
                pair_number,
                student1_id,
                student2_id,
                status)
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

            if (nextPairNumber > pairs.results.length) {
              nextPairNumber = 1;
            }
          }
        }
      }
    }

    currentDate = addDays(currentDate, 1);
  }

  console.log(
    `Duties generated: ${generated}`
  );
}


/* =====================================================
   GET TODAY'S DUTY
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
   SEND DUTY MESSAGE
===================================================== */

async function sendDutyNotification(env, type) {
  const setting = await env.DB.prepare(
    `SELECT value
     FROM settings
     WHERE key = 'group_chat_id'`
  ).first();

  if (!setting || !setting.value) {
    console.log("Group chat ID not saved yet");
    return;
  }

  const duty = await getTodayDuty(env);

  if (!duty) {
    console.log("No duty today");
    return;
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
      if (student1 === oldStudent.full_name) {
        student1 = newStudent.full_name;
      }

      if (student2 === oldStudent.full_name) {
        student2 = newStudent.full_name;
      }

      replacementText =
        `\n\n🔄 Замена:\n` +
        `${oldStudent.full_name} → ${newStudent.full_name}`;
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

  await telegram("sendMessage", {
    chat_id: setting.value,
    text
  }, env);

  console.log(
    `Sent ${type} notification for ${today}`
  );
}


/* =====================================================
   SCHEDULED TASKS
===================================================== */

async function runScheduledTasks(env) {
  try {
    /*
       Сначала обеспечиваем наличие будущих
       дежурств.
    */
    await generateDuties(env);

    const now = getLocalTime();
    const today = getLocalDate();

    /*
       07:00
    */
    if (now.hour === 7 && now.minute === 0) {
      const key = "last_morning_notification";

      const setting = await env.DB.prepare(
        `SELECT value
         FROM settings
         WHERE key = ?`
      )
        .bind(key)
        .first();

      if (!setting || setting.value !== today) {
        await sendDutyNotification(env, "morning");

        await env.DB.prepare(
          `INSERT OR REPLACE INTO settings
           (key, value)
           VALUES (?, ?)`
        )
          .bind(key, today)
          .run();
      }
    }

    /*
       12:00
    */
    if (now.hour === 12 && now.minute === 0) {
      const key = "last_duty_reminder";

      const setting = await env.DB.prepare(
        `SELECT value
         FROM settings
         WHERE key = ?`
      )
        .bind(key)
        .first();

      if (!setting || setting.value !== today) {
        await sendDutyNotification(env, "reminder");

        await env.DB.prepare(
          `INSERT OR REPLACE INTO settings
           (key, value)
           VALUES (?, ?)`
        )
          .bind(key, today)
          .run();
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
   DATE / TIME HELPERS
===================================================== */

function getLocalDate() {
  const parts = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).formatToParts(new Date());

  const year = parts.find(
    p => p.type === "year"
  ).value;

  const month = parts.find(
    p => p.type === "month"
  ).value;

  const day = parts.find(
    p => p.type === "day"
  ).value;

  return `${year}-${month}-${day}`;
}


function getLocalTime() {
  const parts = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  ).formatToParts(new Date());

  let hour = Number(
    parts.find(p => p.type === "hour").value
  );

  const minute = Number(
    parts.find(p => p.type === "minute").value
  );

  /*
     Некоторые JS-реализации могут вернуть 24
     вместо 00.
  */
  if (hour === 24) {
    hour = 0;
  }

  return {
    hour,
    minute
  };
}


function getDayOfWeek(dateString) {
  const [year, month, day] =
    dateString.split("-").map(Number);

  return new Date(
    Date.UTC(year, month - 1, day)
  ).getUTCDay();
}


function addDays(dateString, days) {
  const [year, month, day] =
    dateString.split("-").map(Number);

  const date = new Date(
    Date.UTC(year, month - 1, day)
  );

  date.setUTCDate(
    date.getUTCDate() + days
  );

  return date.toISOString().slice(0, 10);
}


function formatDate(date) {
  if (!date) return "";

  const parts = date.split("-");

  if (parts.length !== 3) {
    return date;
  }

  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}
