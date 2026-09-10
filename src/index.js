const TIMEZONE = "Europe/Simferopol";
const ACADEMIC_YEAR = "2026-2027";
const DUTY_START_DATE = "2026-09-02";
const DUTY_GENERATE_DAYS = 60;
const LINK_CODE_TTL_MINUTES = 15;

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

if (update.channel_post) {
  await handleChannelPost(update.channel_post, env);
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

  /* Сохраняем ID группы */
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
        `🆔 Твой Telegram ID:\n\n` +
        `${telegramId}\n\n` +
        `ℹ️ Для привязки этот ID передавать не нужно.\n` +
        `Староста или заместитель выдаёт одноразовый код.`
    }, env);

    return;
  }

  if (text === "/cancel") {
    await clearPendingInput(telegramId, env);

    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "❌ Текущее действие отменено.",
      reply_markup: backMenu()
    }, env);

    return;
  }

  /*
     Код привязки обрабатываем только в личном чате.
  */
  if (
    /^\d{6}$/.test(text) &&
    message.chat &&
    message.chat.type === "private"
  ) {
    const linked = await processTelegramLinkCode(
      message,
      text,
      env
    );

    if (linked) return;
  }

  const handledInput = await handlePendingInput(
    message,
    telegramId,
    text,
    env
  );

  if (handledInput) return;

  await showMainMenu(
    message.chat.id,
    telegramId,
    env
  );
}
/* =====================================================
   CHANNEL
===================================================== */

async function handleChannelPost(message, env) {
  if (!message || !message.chat) {
    return;
  }

  if (message.chat.type !== "channel") {
    return;
  }

  const channelId = String(message.chat.id);
  const channelTitle = message.chat.title || "ПК-38";

  await env.DB.prepare(
    `INSERT OR REPLACE INTO settings (key, value)
     VALUES ('channel_chat_id', ?)`
  )
    .bind(channelId)
    .run();

  await env.DB.prepare(
    `INSERT OR REPLACE INTO settings (key, value)
     VALUES ('channel_title', ?)`
  )
    .bind(channelTitle)
    .run();

  console.log(
    `CHANNEL CONNECTED: ${channelTitle} (${channelId})`
  );
}
async function publishToChannel(text, env) {
  const channelId =
    await getSetting("channel_chat_id", env);

  if (!channelId) {
    console.log("CHANNEL NOT CONNECTED YET");
    return false;
  }

  const result = await telegram(
    "sendMessage",
    {
      chat_id: channelId,
      text: text
    },
    env
  );

  if (!result.ok) {
    console.error(
      "CHANNEL SEND ERROR:",
      result.description
    );

    return false;
  }

  return true;
}
/* =====================================================
   START
===================================================== */

async function startCommand(message, env) {
  const telegramId = message.from.id;
  const username = message.from.username || null;

  const student = await env.DB.prepare(
    `SELECT *
     FROM students
     WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  if (student) {
    await env.DB.prepare(
      `UPDATE students
       SET username = ?
       WHERE id = ?`
    )
      .bind(username, student.id)
      .run();

    student.username = username;

    await sendMainMenu(
      message.chat.id,
      student,
      env
    );

    return;
  }

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text:
      `👋 Привет!\n\n` +
      `Это «Помощник ПК-38».\n\n` +
      `🔗 Твой Telegram пока не привязан к списку группы.\n\n` +
      `Попроси старосту или заместителя выдать тебе ` +
      `одноразовый код из 6 цифр.\n\n` +
      `После этого просто отправь код сюда.\n\n` +
      `Например:\n482731`
  }, env);
}


/* =====================================================
   TELEGRAM LINK CODE
===================================================== */

async function processTelegramLinkCode(
  message,
  code,
  env
) {
  const telegramId = message.from.id;
  const username = message.from.username || null;

  const linkCode = await env.DB.prepare(
    `SELECT
       code,
       student_id,
       expires_at,
       used_at
     FROM link_codes
     WHERE code = ?`
  )
    .bind(code)
    .first();

  if (!linkCode) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `❌ Такой код не найден.\n\n` +
        `Проверь код и отправь его ещё раз.`
    }, env);

    return true;
  }

  if (linkCode.used_at) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `❌ Этот код уже использован.\n\n` +
        `Попроси новый код у старосты или заместителя.`
    }, env);

    return true;
  }

  const expiresAt =
    new Date(linkCode.expires_at).getTime();

  if (
    !Number.isFinite(expiresAt) ||
    expiresAt < Date.now()
  ) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `⏰ Срок действия этого кода истёк.\n\n` +
        `Попроси старосту или заместителя выдать новый.`
    }, env);

    return true;
  }

  const existingStudent = await env.DB.prepare(
    `SELECT id, full_name
     FROM students
     WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  if (
    existingStudent &&
    Number(existingStudent.id) !==
      Number(linkCode.student_id)
  ) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `⚠️ Этот Telegram уже привязан к другому участнику группы.\n\n` +
        `Обратись к старосте.`
    }, env);

    return true;
  }

  const student = await env.DB.prepare(
    `SELECT
       id,
       full_name,
       role
     FROM students
     WHERE id = ?`
  )
    .bind(linkCode.student_id)
    .first();

  if (!student) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `❌ Участник для этого кода не найден.\n\n` +
        `Попроси создать новый код.`
    }, env);

    return true;
  }

  await env.DB.prepare(
    `UPDATE students
     SET
       telegram_id = ?,
       username = ?
     WHERE id = ?`
  )
    .bind(
      telegramId,
      username,
      student.id
    )
    .run();

  await env.DB.prepare(
    `UPDATE link_codes
     SET used_at = CURRENT_TIMESTAMP
     WHERE code = ?`
  )
    .bind(code)
    .run();

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text:
      `✅ Telegram успешно привязан!\n\n` +
      `👤 ${student.full_name}\n\n` +
      `Теперь тебе доступны функции «Помощника ПК-38».`
  }, env);

  await sendMainMenu(
    message.chat.id,
    {
      id: student.id,
      full_name: student.full_name,
      role: student.role,
      telegram_id: telegramId,
      username
    },
    env
  );

  return true;
}


/* =====================================================
   MAIN MENU
===================================================== */

async function showMainMenu(
  chatId,
  telegramId,
  env
) {
  const student = await env.DB.prepare(
    `SELECT *
     FROM students
     WHERE telegram_id = ?`
  )
    .bind(telegramId)
    .first();

  if (!student) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❗ Ты пока не привязан к группе.\n\n` +
        `Нажми /start и попроси у старосты ` +
        `одноразовый код.`
    }, env);

    return;
  }

  await sendMainMenu(
    chatId,
    student,
    env
  );
}


async function sendMainMenu(
  chatId,
  student,
  env
) {
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
      {
        text: "☀️ Сегодня",
        callback_data: "today"
      },
      {
        text: "📅 Расписание",
        callback_data: "schedule"
      }
    ],
    [
      {
        text: "📚 ДЗ",
        callback_data: "homework"
      },
      {
        text: "🧹 Дежурство",
        callback_data: "duty"
      }
    ],
    [
      {
        text: "📊 Моя статистика",
        callback_data: "stats"
      },
      {
        text: "📢 Объявления",
        callback_data: "announcements"
      }
    ],
    [
      {
        text: "⏰ Я опоздаю",
        callback_data: "late"
      }
    ]
  ];

  if (
    role === "admin" ||
    role === "deputy"
  ) {
    keyboard.push([
      {
        text: "👑 Админ-панель",
        callback_data: "admin"
      }
    ]);
  }

  return {
    inline_keyboard: keyboard
  };
}


/* =====================================================
   CALLBACKS
===================================================== */

async function handleCallback(
  query,
  env
) {
  if (!query.message) return;

  const chatId =
    query.message.chat.id;

  const telegramId =
    query.from.id;

  const data =
    query.data || "";

  await telegram(
    "answerCallbackQuery",
    {
      callback_query_id: query.id
    },
    env
  );

  /* ---------- STUDENT ---------- */

  if (data === "today") {
    await showToday(
      chatId,
      telegramId,
      env
    );
    return;
  }

  if (data === "schedule") {
    await showSchedule(
      chatId,
      env
    );
    return;
  }

  if (data.startsWith("day_")) {
    const day =
      Number(
        data.replace(
          "day_",
          ""
        )
      );

    await showScheduleDay(
      chatId,
      day,
      env
    );

    return;
  }

  if (data === "today_schedule") {
    await showToday(
      chatId,
      telegramId,
      env
    );
    return;
  }

  if (data === "current_lesson") {
    await showCurrentLesson(
      chatId,
      env
    );
    return;
  }

  if (data === "duty") {
    await showDuty(
      chatId,
      telegramId,
      env
    );
    return;
  }

  /* ---------- HOMEWORK ---------- */

  if (data === "homework") {
    await showHomeworkMenu(
      chatId,
      env
    );
    return;
  }

  if (
    data === "hw_today" ||
    data === "hw_tomorrow" ||
    data === "hw_week" ||
    data === "hw_all"
  ) {
    await showHomework(
      chatId,
      data.replace(
        "hw_",
        ""
      ),
      env
    );

    return;
  }

  /* ---------- OTHER ---------- */

  if (data === "replacement") {
  await beginReplacement(
    chatId,
    telegramId,
    env
  );

  return;
}

if (data.startsWith("replacement_select_")) {
  const replacementId = Number(
    data.replace("replacement_select_", "")
  );

  await selectReplacementPerson(
    chatId,
    telegramId,
    replacementId,
    env
  );

  return;
}

if (data.startsWith("replacement_accept_")) {
  const replacementId = Number(
    data.replace("replacement_accept_", "")
  );

  await answerReplacement(
    chatId,
    telegramId,
    replacementId,
    true,
    env
  );

  return;
}

if (data.startsWith("replacement_reject_")) {
  const replacementId = Number(
    data.replace("replacement_reject_", "")
  );

  await answerReplacement(
    chatId,
    telegramId,
    replacementId,
    false,
    env
  );

  return;
}

if (data.startsWith("replacement_approve_")) {
  const replacementId = Number(
    data.replace("replacement_approve_", "")
  );

  await approveReplacement(
    chatId,
    telegramId,
    replacementId,
    env
  );

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

const channelPublished =
  await publishToChannel(
    `📢 ОБЪЯВЛЕНИЕ\n\n` +
    `${announcementText}\n\n` +
    `#ОБЪЯВЛЕНИЯ`,
    env
  );

    return;
  }

  if (data === "back") {
    await showMainMenu(
      chatId,
      telegramId,
      env
    );

    return;
  }

  /* ===================================================
     ADMIN
  =================================================== */

  if (data === "admin") {
    await showAdmin(
      chatId,
      telegramId,
      env
    );

    return;
  }

  if (data === "admin_duties") {
    await showAdminDuties(
      chatId,
      telegramId,
      env
    );

    return;
  }

  if (data === "admin_students") {
    await showAdminStudents(
      chatId,
      telegramId,
      env
    );

    return;
  }

  if (data.startsWith("admin_student_")) {
    const id =
      Number(
        data.replace(
          "admin_student_",
          ""
        )
      );

    await showAdminStudent(
      chatId,
      telegramId,
      id,
      env
    );

    return;
  }

  if (data.startsWith("student_link_")) {
    const id =
      Number(
        data.replace(
          "student_link_",
          ""
        )
      );

    await createTelegramLinkCode(
      chatId,
      telegramId,
      id,
      env
    );

    return;
  }

  if (data.startsWith("student_unlink_")) {
    const id =
      Number(
        data.replace(
          "student_unlink_",
          ""
        )
      );

    await unlinkTelegram(
      chatId,
      telegramId,
      id,
      env
    );

    return;
  }

  if (data === "admin_calendar") {
    await adminPlaceholder(
      chatId,
      "📅 Календарь",
      env
    );

    return;
  }

  if (data === "admin_schedule") {
    await showAdminSchedule(
      chatId,
      telegramId,
      env
    );

    return;
  }

  if (data === "admin_homework") {
    await showAdminHomework(
      chatId,
      telegramId,
      env
    );

    return;
  }

  if (data === "admin_announcements") {
    await adminPlaceholder(
      chatId,
      "📢 Управление объявлениями",
      env
    );

    return;
  }

  if (data === "admin_alerts") {
    await showAdminAlerts(
      chatId,
      telegramId,
      env
    );

    return;
  }

  if (data === "admin_attendance") {
    await adminPlaceholder(
      chatId,
      "🕐 Посещаемость",
      env
    );

    return;
  }

  if (data === "admin_replacements") {
    await adminPlaceholder(
      chatId,
      "🔄 Замены",
      env
    );

    return;
  }

  if (data === "admin_stats") {
    await adminPlaceholder(
      chatId,
      "📊 Статистика группы",
      env
    );

    return;
  }

  if (data === "admin_year") {
    await adminPlaceholder(
      chatId,
      "🎓 Учебный год",
      env
    );

    return;
  }

  if (data === "admin_settings") {
    await adminPlaceholder(
      chatId,
      "⚙️ Настройки",
      env
    );

    return;
  }

  if (data === "admin_backup") {
    await adminPlaceholder(
      chatId,
      "💾 Резервная копия",
      env
    );

    return;
  }

  /* ===================================================
     ADMIN ALERTS
  =================================================== */

  if (data === "alert_air") {
    await sendManualAlert(
      chatId,
      telegramId,
      "air",
      env
    );

    return;
  }

  if (data === "alert_end_air") {
    await sendManualAlert(
      chatId,
      telegramId,
      "end_air",
      env
    );

    return;
  }

  /* ===================================================
     ADMIN HOMEWORK
  =================================================== */

  if (data === "hw_admin_add") {
    if (!(await isAdmin(telegramId, env))) {
      return;
    }

    await beginPendingInput(
      telegramId,
      "hw_add_date",
      {},
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `➕ Добавление ДЗ\n\n` +
        `Шаг 1 из 4.\n\n` +
        `Введи дату:\n\n` +
        `ДД.ММ.ГГГГ\n\n` +
        `Например: 09.09.2026\n\n` +
        `Для отмены: /cancel`
    }, env);

    return;
  }

  if (data === "hw_admin_list") {
    await showAdminHomeworkList(
      chatId,
      telegramId,
      env
    );

    return;
  }

  if (data.startsWith("hw_edit_")) {
    const id =
      Number(
        data.replace(
          "hw_edit_",
          ""
        )
      );

    await beginHomeworkEdit(
      chatId,
      telegramId,
      id,
      env
    );

    return;
  }

  if (data.startsWith("hw_delete_")) {
    const id =
      Number(
        data.replace(
          "hw_delete_",
          ""
        )
      );

    await deleteHomework(
      chatId,
      telegramId,
      id,
      env
    );

    return;
  }

  if (data.startsWith("hw_archive_")) {
    const id =
      Number(
        data.replace(
          "hw_archive_",
          ""
        )
      );

    await archiveHomework(
      chatId,
      telegramId,
      id,
      env
    );

    return;
  }

  if (data.startsWith("hw_copy_")) {
    const id =
      Number(
        data.replace(
          "hw_copy_",
          ""
        )
      );

    await beginHomeworkCopy(
      chatId,
      telegramId,
      id,
      env
    );

    return;
  }

  /* ===================================================
     ADMIN SCHEDULE
  =================================================== */

  if (data === "sch_admin_menu") {
    await showAdminSchedule(
      chatId,
      telegramId,
      env
    );

    return;
  }

  if (data.startsWith("sch_day_")) {
    const day =
      Number(
        data.replace(
          "sch_day_",
          ""
        )
      );

    await showAdminScheduleDay(
      chatId,
      telegramId,
      day,
      env
    );

    return;
  }

  if (data === "sch_admin_add") {
    await beginScheduleAdd(
      chatId,
      telegramId,
      env
    );

    return;
  }

  if (data.startsWith("sch_edit_")) {
    const id =
      Number(
        data.replace(
          "sch_edit_",
          ""
        )
      );

    await beginScheduleEdit(
      chatId,
      telegramId,
      id,
      env
    );

    return;
  }

  if (data.startsWith("sch_delete_")) {
    const id =
      Number(
        data.replace(
          "sch_delete_",
          ""
        )
      );

    await deleteScheduleLesson(
      chatId,
      telegramId,
      id,
      env
    );

    return;
  }

  if (data.startsWith("sch_exception_")) {
    const day =
      Number(
        data.replace(
          "sch_exception_",
          ""
        )
      );

    await beginScheduleException(
      chatId,
      telegramId,
      day,
      env
    );

    return;
  }

  if (data.startsWith("sch_exceptions_")) {
    const day =
      Number(
        data.replace(
          "sch_exceptions_",
          ""
        )
      );

    await showScheduleExceptions(
      chatId,
      telegramId,
      day,
      env
    );

    return;
  }

  if (data.startsWith("sch_ex_delete_")) {
    const id =
      Number(
        data.replace(
          "sch_ex_delete_",
          ""
        )
      );

    await deleteScheduleException(
      chatId,
      telegramId,
      id,
      env
    );

    return;
  }

  if (data.startsWith("sch_copy_")) {
    const day =
      Number(
        data.replace(
          "sch_copy_",
          ""
        )
      );

    await beginScheduleCopy(
      chatId,
      telegramId,
      day,
      env
    );

    return;
  }

/* =====================================================
   TODAY
===================================================== */

async function showToday(
  chatId,
  telegramId,
  env
) {
  const dateString =
    getLocalDate();

  const day =
    getDayOfWeek(dateString);

  if (
    day === 0 ||
    day === 6
  ) {
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

async function showSchedule(
  chatId,
  env
) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📅 Расписание\n\n` +
      `Выбери день:`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Понедельник",
            callback_data: "day_1"
          },
          {
            text: "Вторник",
            callback_data: "day_2"
          }
        ],
        [
          {
            text: "Среда",
            callback_data: "day_3"
          },
          {
            text: "Четверг",
            callback_data: "day_4"
          }
        ],
        [
          {
            text: "Пятница",
            callback_data: "day_5"
          }
        ],
        [
          {
            text: "☀️ Сегодня",
            callback_data: "today_schedule"
          },
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
      text:
        "❗ Расписание для этого дня недоступно.",
      reply_markup: backMenu()
    }, env);

    return;
  }

  const result =
    await getScheduleForDate(
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
    text +=
      `📆 ${formatDate(specificDate)}\n`;
  }

  text += `\n`;

  for (const lesson of result) {
    text +=
      `${lesson.lesson_number}. ` +
      `${lesson.start_time}–${lesson.end_time}\n` +
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
  const baseResult =
    await env.DB.prepare(
      `SELECT
         id,
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
      .bind(
        day,
        ACADEMIC_YEAR
      )
      .all();

  const lessons =
    (baseResult.results || [])
      .map(
        lesson => ({
          ...lesson
        })
      );

  if (!specificDate) {
    return lessons;
  }

  const exceptionResult =
    await env.DB.prepare(
      `SELECT
         id,
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

  for (
    const exception
    of exceptionResult.results || []
  ) {
    const index =
      lessons.findIndex(
        lesson =>
          Number(
            lesson.lesson_number
          ) ===
          Number(
            exception.lesson_number
          )
      );

    if (
      exception.action ===
      "delete"
    ) {
      if (index >= 0) {
        lessons.splice(
          index,
          1
        );
      }

      continue;
    }

    const base =
      index >= 0
        ? lessons[index]
        : {};

    const changed = {
      id:
        base.id ||
        null,

      lesson_number:
        exception.lesson_number,

      start_time:
        exception.start_time ||
        base.start_time ||
        "",

      end_time:
        exception.end_time ||
        base.end_time ||
        "",

      subject:
        exception.subject ||
        base.subject ||
        "",

      teacher:
        exception.teacher ||
        base.teacher ||
        null,

      room:
        exception.room ||
        base.room ||
        null
    };

    if (index >= 0) {
      lessons[index] =
        changed;
    } else {
      lessons.push(
        changed
      );
    }
  }

  lessons.sort(
    (a, b) =>
      Number(
        a.lesson_number
      ) -
      Number(
        b.lesson_number
      )
  );

  return lessons;
}


/* =====================================================
   CURRENT LESSON
===================================================== */

async function showCurrentLesson(
  chatId,
  env
) {
  const date =
    getLocalDate();

  const day =
    getDayOfWeek(date);

  if (
    day === 0 ||
    day === 6
  ) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `⚡ Сейчас занятий нет.\n\n` +
        `Сегодня выходной.`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  const time =
    getLocalTime();

  const currentMinutes =
    time.hour * 60 +
    time.minute;

  const lessons =
    await getScheduleForDate(
      date,
      day,
      env
    );

  let current = null;
  let next = null;

  for (const lesson of lessons) {
    const start =
      timeToMinutes(
        lesson.start_time
      );

    const end =
      timeToMinutes(
        lesson.end_time
      );

    if (
      currentMinutes >= start &&
      currentMinutes < end
    ) {
      current = lesson;
      break;
    }

    if (
      start > currentMinutes &&
      !next
    ) {
      next = lesson;
    }
  }

  let text =
    `⚡ Что сейчас?\n\n`;

  if (current) {
    text +=
      `🔴 Сейчас идёт ` +
      `${current.lesson_number}-я пара\n\n` +
      `📚 ${current.subject}\n` +
      `👨‍🏫 ${current.teacher || "Не указан"}\n` +
      `🚪 ${current.room || "Не указан"}\n` +
      `⏰ ${current.start_time}–${current.end_time}`;
  } else if (next) {
    text +=
      `🟢 Сейчас перемена.\n\n` +
      `Следующая — ` +
      `${next.lesson_number}-я пара\n` +
      `⏰ ${next.start_time}–${next.end_time}\n` +
      `📚 ${next.subject}\n` +
      `🚪 ${next.room || "Не указан"}`;
  } else {
    text +=
      `🏠 На сегодня занятия уже закончились.`;
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

async function showHomeworkMenu(
  chatId,
  env
) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📚 Домашнее задание\n\n` +
      `Выбери период:`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📅 Сегодня",
            callback_data: "hw_today"
          },
          {
            text: "➡️ Завтра",
            callback_data: "hw_tomorrow"
          }
        ],
        [
          {
            text: "📆 На неделю",
            callback_data: "hw_week"
          },
          {
            text: "📚 Все ДЗ",
            callback_data: "hw_all"
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
   HOMEWORK
===================================================== */

async function showHomework(
  chatId,
  type,
  env
) {
  const today =
    getLocalDate();

  let from = today;
  let to = today;
  let title =
    "📚 ДЗ на сегодня";

  if (type === "tomorrow") {
    from =
      addDays(
        today,
        1
      );

    to = from;

    title =
      "📚 ДЗ на завтра";
  }

  if (type === "week") {
    from = today;

    to =
      addDays(
        today,
        6
      );

    title =
      "📚 ДЗ на неделю";
  }

  if (type === "all") {
    from = "0000-01-01";
    to = "9999-12-31";

    title =
      "📚 Все ДЗ";
  }

  const result =
    await env.DB.prepare(
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
       ORDER BY
         lesson_date ASC,
         COALESCE(lesson_number, 99) ASC,
         id ASC
       LIMIT 100`
    )
      .bind(
        from,
        to
      )
      .all();

  const rows =
    result.results || [];

  if (!rows.length) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `${title}\n\n` +
        `Пока заданий нет. 🎉`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  let text =
    `${title}\n\n`;

  let currentDate = "";

  for (
    const homework
    of rows
  ) {
    if (
      homework.lesson_date !==
      currentDate
    ) {
      currentDate =
        homework.lesson_date;

      text +=
        `📅 ${formatDate(currentDate)}\n`;
    }

    text +=
      `📚 ${homework.subject}\n`;

    if (
      homework.lesson_number
    ) {
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
   ADMIN ACCESS
===================================================== */

async function isAdmin(
  telegramId,
  env
) {
  const student =
    await env.DB.prepare(
      `SELECT role
       FROM students
       WHERE telegram_id = ?`
    )
      .bind(telegramId)
      .first();

  return !!(
    student &&
    (
      student.role === "admin" ||
      student.role === "deputy"
    )
  );
}


/* =====================================================
   ADMIN MENU
===================================================== */

async function showAdmin(
  chatId,
  telegramId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        "⛔ У тебя нет доступа к админ-панели."
    }, env);

    return;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      "👑 Админ-панель",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🧹 Дежурства",
            callback_data: "admin_duties"
          },
          {
            text: "📅 Календарь",
            callback_data: "admin_calendar"
          }
        ],
        [
          {
            text: "📚 Расписание",
            callback_data: "admin_schedule"
          },
          {
            text: "📚 ДЗ",
            callback_data: "admin_homework"
          }
        ],
        [
          {
            text: "📢 Объявления",
            callback_data: "admin_announcements"
          },
          {
            text: "📢 Оповещения",
            callback_data: "admin_alerts"
          }
        ],
        [
          {
            text: "🕐 Посещаемость",
            callback_data: "admin_attendance"
          },
          {
            text: "🔄 Замены",
            callback_data: "admin_replacements"
          }
        ],
        [
          {
            text: "📊 Статистика",
            callback_data: "admin_stats"
          },
          {
            text: "👥 Участники",
            callback_data: "admin_students"
          }
        ],
        [
          {
            text: "🎓 Учебный год",
            callback_data: "admin_year"
          },
          {
            text: "⚙️ Настройки",
            callback_data: "admin_settings"
          }
        ],
        [
          {
            text: "💾 Резервная копия",
            callback_data: "admin_backup"
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
   ADMIN ALERTS
===================================================== */

async function showAdminAlerts(
  chatId,
  telegramId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📢 Оповещения\n\n` +
      `Выбери действие:`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🚨 Тревога",
            callback_data: "alert_air"
          }
        ],
        [
          {
            text: "🟢 Отмена тревоги",
            callback_data: "alert_end_air"
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


async function sendManualAlert(
  chatId,
  telegramId,
  type,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const setting =
    await env.DB.prepare(
      `SELECT value
       FROM settings
       WHERE key = 'group_chat_id'`
    )
      .first();

  if (
    !setting ||
    !setting.value
  ) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❌ ID группы пока не сохранён.\n\n` +
        `Сначала отправь сообщение в тестовой группе.`
    }, env);

    return;
  }

  let text;

  if (type === "air") {
    text =
      `🚨 ВНИМАНИЕ!\n\n` +
      `Включено оповещение.\n` +
      `Следуйте указаниям администрации.`;
  } else {
    text =
      `🟢 ОТБОЙ ОПОВЕЩЕНИЯ\n\n` +
      `Оповещение завершено.`;
  }

  const result =
    await telegram(
      "sendMessage",
      {
        chat_id: setting.value,
        text
      },
      env
    );

  if (result.ok) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `✅ Оповещение отправлено в группу.`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📢 Оповещения",
              callback_data: "admin_alerts"
            }
          ],
          [
            {
              text: "◀️ Админ-панель",
              callback_data: "admin"
            }
          ]
        ]
      }
    }, env);
  } else {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❌ Не удалось отправить сообщение в группу.\n\n` +
        `${result.description || "Ошибка Telegram"}`
    }, env);
  }
}


/* =====================================================
   ADMIN STUDENTS
===================================================== */

async function showAdminStudents(
  chatId,
  telegramId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⛔ Нет доступа."
    }, env);

    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         id,
         full_name,
         username,
         role,
         telegram_id,
         phone,
         is_active
       FROM students
       WHERE is_active = 1
       ORDER BY full_name`
    ).all();

  const rows =
    result.results || [];

  let text =
    `👥 Участники ПК-38\n\n` +
    `Количество: ${rows.length}\n\n` +
    `Выбери участника:`;

  const buttons = [];

  for (const student of rows) {
    buttons.push([
      {
        text:
          `${student.telegram_id ? "🟢" : "⚪"} ` +
          `${student.full_name}`,
        callback_data:
          `admin_student_${student.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "◀️ В админ-панель",
      callback_data: "admin"
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


async function showAdminStudent(
  chatId,
  telegramId,
  studentId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const student =
    await env.DB.prepare(
      `SELECT
         id,
         full_name,
         phone,
         telegram_id,
         username,
         role,
         is_active
       FROM students
       WHERE id = ?`
    )
      .bind(studentId)
      .first();

  if (!student) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❌ Участник не найден.`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "◀️ К участникам",
              callback_data: "admin_students"
            }
          ]
        ]
      }
    }, env);

    return;
  }

  const status =
    student.is_active
      ? "🟢 Активен"
      : "⚪ Неактивен";

  const telegramStatus =
    student.telegram_id
      ? "🟢 Привязан"
      : "⚪ Не привязан";

  let text =
    `👤 Участник ПК-38\n\n` +
    `ФИО:\n${student.full_name}\n\n` +
    `📱 Телефон:\n${student.phone || "Не указан"}\n\n` +
    `🆔 Telegram ID:\n${student.telegram_id || "Не привязан"}\n\n` +
    `🔗 Username:\n${student.username ? "@" + student.username : "Нет"}\n\n` +
    `👑 Роль:\n${student.role}\n\n` +
    `📌 Статус:\n${status}\n` +
    `${telegramStatus}`;

  const buttons = [];

  if (student.telegram_id) {
    buttons.push([
      {
        text: "🔓 Отвязать Telegram",
        callback_data:
          `student_unlink_${student.id}`
      }
    ]);
  } else {
    buttons.push([
      {
        text: "🔗 Привязать Telegram",
        callback_data:
          `student_link_${student.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "◀️ К участникам",
      callback_data: "admin_students"
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


/* =====================================================
   CREATE LINK CODE
===================================================== */

async function createTelegramLinkCode(
  chatId,
  telegramId,
  studentId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const student =
    await env.DB.prepare(
      `SELECT
         id,
         full_name,
         telegram_id
       FROM students
       WHERE id = ?`
    )
      .bind(studentId)
      .first();

  if (!student) {
    return;
  }

  if (student.telegram_id) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `⚠️ У этого участника уже привязан Telegram.`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "◀️ Назад",
              callback_data:
                `admin_student_${studentId}`
            }
          ]
        ]
      }
    }, env);

    return;
  }

  /* Удаляем старые коды этого ученика */
  await env.DB.prepare(
    `DELETE FROM link_codes
     WHERE student_id = ?`
  )
    .bind(studentId)
    .run();

  let code = null;

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate =
      generateSixDigitCode();

    const exists =
      await env.DB.prepare(
        `SELECT code
         FROM link_codes
         WHERE code = ?`
      )
        .bind(candidate)
        .first();

    if (!exists) {
      code = candidate;
      break;
    }
  }

  if (!code) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❌ Не удалось создать код.\n\n` +
        `Попробуй ещё раз.`
    }, env);

    return;
  }

  const expiresAt =
    new Date(
      Date.now() +
      LINK_CODE_TTL_MINUTES *
      60 *
      1000
    ).toISOString();

  await env.DB.prepare(
    `INSERT INTO link_codes
     (
       code,
       student_id,
       expires_at,
       created_by
     )
     VALUES (?, ?, ?, ?)`
  )
    .bind(
      code,
      studentId,
      expiresAt,
      telegramId
    )
    .run();

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `🔗 Код привязки создан!\n\n` +
      `👤 ${student.full_name}\n\n` +
      `🔢 Код:\n` +
      `\`${code}\`\n\n` +
      `⏰ Действует ${LINK_CODE_TTL_MINUTES} минут.\n\n` +
      `Передай этот код именно этому ученику.\n\n` +
      `Ученик должен открыть личный чат с ботом и отправить код.`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🔄 Создать новый код",
            callback_data:
              `student_link_${studentId}`
          }
        ],
        [
          {
            text: "◀️ К участнику",
            callback_data:
              `admin_student_${studentId}`
          }
        ]
      ]
    }
  }, env);
}


function generateSixDigitCode() {
  const array =
    new Uint32Array(1);

  crypto.getRandomValues(array);

  return String(
    100000 +
    (array[0] % 900000)
  );
}


/* =====================================================
   UNLINK TELEGRAM
===================================================== */

async function unlinkTelegram(
  chatId,
  telegramId,
  studentId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const student =
    await env.DB.prepare(
      `SELECT
         id,
         full_name
       FROM students
       WHERE id = ?`
    )
      .bind(studentId)
      .first();

  if (!student) {
    return;
  }

  await env.DB.prepare(
    `UPDATE students
     SET
       telegram_id = NULL,
       username = NULL
     WHERE id = ?`
  )
    .bind(studentId)
    .run();

  await env.DB.prepare(
    `DELETE FROM link_codes
     WHERE student_id = ?`
  )
    .bind(studentId)
    .run();

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `🔓 Telegram отвязан.\n\n` +
      `👤 ${student.full_name}`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🔗 Привязать заново",
            callback_data:
              `student_link_${studentId}`
          }
        ],
        [
          {
            text: "◀️ К участникам",
            callback_data: "admin_students"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   ADMIN HOMEWORK MENU
===================================================== */

async function showAdminHomework(
  chatId,
  telegramId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
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
      `Что сделать?`,
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
            text: "📋 Активные ДЗ",
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
   ADMIN HOMEWORK LIST
===================================================== */

async function showAdminHomeworkList(
  chatId,
  telegramId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         id,
         lesson_date,
         subject,
         text,
         lesson_number
       FROM homework
       WHERE is_archived = 0
       ORDER BY lesson_date ASC, id ASC
       LIMIT 50`
    ).all();

  const rows =
    result.results || [];

  if (!rows.length) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `📚 Активных ДЗ пока нет.`,
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
              text: "◀️ Назад",
              callback_data: "admin_homework"
            }
          ]
        ]
      }
    }, env);

    return;
  }

  let text =
    `📚 Активные домашние задания\n\n`;

  const buttons = [];

  for (const hw of rows) {
    text +=
      `🆔 ${hw.id}\n` +
      `📅 ${formatDate(hw.lesson_date)}\n` +
      `📚 ${hw.subject}\n`;

    if (hw.lesson_number) {
      text +=
        `🔢 Пара №${hw.lesson_number}\n`;
    }

    text +=
      `📝 ${hw.text}\n\n`;

    buttons.push([
      {
        text:
          `✏️ Изменить №${hw.id}`,
        callback_data:
          `hw_edit_${hw.id}`
      },
      {
        text: `📋 Копия`,
        callback_data:
          `hw_copy_${hw.id}`
      }
    ]);

    buttons.push([
      {
        text:
          `📦 Архив №${hw.id}`,
        callback_data:
          `hw_archive_${hw.id}`
      },
      {
        text:
          `🗑 Удалить`,
        callback_data:
          `hw_delete_${hw.id}`
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


/* =====================================================
   HOMEWORK ADD
===================================================== */

async function processHomeworkAdd(
  message,
  telegramId,
  text,
  state,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await clearPendingInput(
      telegramId,
      env
    );

    return true;
  }

  const chatId =
    message.chat.id;

  if (
    state.action ===
    "hw_add_date"
  ) {
    const date =
      parseRussianDate(text);

    if (!date) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          `❗ Неверная дата.\n\n` +
          `Используй формат:\n` +
          `ДД.ММ.ГГГГ`
      }, env);

      return true;
    }

    await beginPendingInput(
      telegramId,
      "hw_add_subject",
      {
        date
      },
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `📚 Шаг 2 из 4.\n\n` +
        `Дата: ${formatDate(date)}\n\n` +
        `Введи название предмета.`
    }, env);

    return true;
  }

  if (
    state.action ===
    "hw_add_subject"
  ) {
    if (!text) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "❗ Предмет не может быть пустым."
      }, env);

      return true;
    }

    await beginPendingInput(
      telegramId,
      "hw_add_text",
      {
        date:
          state.data.date,
        subject:
          text
      },
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `📝 Шаг 3 из 4.\n\n` +
        `Введи текст задания.`
    }, env);

    return true;
  }

  if (
    state.action ===
    "hw_add_text"
  ) {
    await beginPendingInput(
      telegramId,
      "hw_add_lesson",
      {
        date:
          state.data.date,
        subject:
          state.data.subject,
        homeworkText:
          text
      },
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `🔢 Шаг 4 из 4.\n\n` +
        `Введи номер пары от 1 до 4.\n\n` +
        `Если номер пары не нужен — напиши 0.`
    }, env);

    return true;
  }

  if (
    state.action ===
    "hw_add_lesson"
  ) {
    const lesson =
      Number(text);

    if (
      !Number.isInteger(lesson) ||
      lesson < 0 ||
      lesson > 4
    ) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          `❗ Напиши число от 0 до 4.`
      }, env);

      return true;
    }

    await env.DB.prepare(
      `INSERT INTO homework
       (
         lesson_date,
         subject,
         text,
         lesson_number,
         added_by
       )
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        state.data.date,
        state.data.subject,
        state.data.homeworkText,
        lesson === 0
          ? null
          : lesson,
        telegramId
      )
      .run();
     
const homeworkChannelText =
  `📚 ДОМАШНЕЕ ЗАДАНИЕ\n\n` +
  `📅 ${formatDate(state.data.date)}\n` +
  `📚 ${state.data.subject}\n\n` +
  `📝 ${state.data.homeworkText}\n\n` +
  `${
    lesson === 0
      ? ""
      : `🔢 Пара №${lesson}\n\n`
  }` +
  `#ДЗ`;

await publishToChannel(
  homeworkChannelText,
  env
);
    await clearPendingInput(
      telegramId,
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `✅ ДЗ добавлено!\n\n` +
        `📅 ${formatDate(state.data.date)}\n` +
        `📚 ${state.data.subject}\n` +
        `📝 ${state.data.homeworkText}\n` +
        `🔢 ${
          lesson === 0
            ? "Пара не указана"
            : `Пара №${lesson}`
        }`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📚 Список ДЗ",
              callback_data:
                "hw_admin_list"
            }
          ],
          [
            {
              text: "◀️ В админ-панель",
              callback_data:
                "admin"
            }
          ]
        ]
      }
    }, env);

    return true;
  }

  return false;
}


/* =====================================================
   HOMEWORK EDIT
===================================================== */

async function beginHomeworkEdit(
  chatId,
  telegramId,
  id,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const hw =
    await env.DB.prepare(
      `SELECT *
       FROM homework
       WHERE id = ?`
    )
      .bind(id)
      .first();

  if (!hw) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        "❗ ДЗ не найдено."
    }, env);

    return;
  }

  await beginPendingInput(
    telegramId,
    "hw_edit_date",
    {
      id,
      subject:
        hw.subject,
      text:
        hw.text,
      lesson:
        hw.lesson_number
    },
    env
  );

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `✏️ Изменение ДЗ №${id}\n\n` +
      `Шаг 1 из 4.\n\n` +
      `Введи новую дату:\n` +
      `ДД.ММ.ГГГГ`
  }, env);
}


async function processHomeworkEdit(
  message,
  telegramId,
  text,
  state,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await clearPendingInput(
      telegramId,
      env
    );

    return true;
  }

  const chatId =
    message.chat.id;

  if (
    state.action ===
    "hw_edit_date"
  ) {
    const date =
      parseRussianDate(text);

    if (!date) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "❗ Используй формат ДД.ММ.ГГГГ."
      }, env);

      return true;
    }

    await beginPendingInput(
      telegramId,
      "hw_edit_subject",
      {
        ...state.data,
        date
      },
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `📚 Шаг 2 из 4.\n\n` +
        `Введи новый предмет.`
    }, env);

    return true;
  }

  if (
    state.action ===
    "hw_edit_subject"
  ) {
    if (!text) {
      return true;
    }

    await beginPendingInput(
      telegramId,
      "hw_edit_text",
      {
        ...state.data,
        subject: text
      },
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `📝 Шаг 3 из 4.\n\n` +
        `Введи новое задание.`
    }, env);

    return true;
  }

  if (
    state.action ===
    "hw_edit_text"
  ) {
    await beginPendingInput(
      telegramId,
      "hw_edit_lesson",
      {
        ...state.data,
        text
      },
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `🔢 Шаг 4 из 4.\n\n` +
        `Номер пары: 1–4.\n` +
        `Или 0, если номер не нужен.`
    }, env);

    return true;
  }

  if (
    state.action ===
    "hw_edit_lesson"
  ) {
    const lesson =
      Number(text);

    if (
      !Number.isInteger(lesson) ||
      lesson < 0 ||
      lesson > 4
    ) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "❗ Введи число от 0 до 4."
      }, env);

      return true;
    }

    await env.DB.prepare(
      `UPDATE homework
       SET
         lesson_date = ?,
         subject = ?,
         text = ?,
         lesson_number = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
      .bind(
        state.data.date,
        state.data.subject,
        state.data.text,
        lesson === 0
          ? null
          : lesson,
        state.data.id
      )
      .run();

    await clearPendingInput(
      telegramId,
      env
    );

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `✅ ДЗ №${state.data.id} изменено!`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📋 Список ДЗ",
              callback_data:
                "hw_admin_list"
            }
          ],
          [
            {
              text: "◀️ Админ-панель",
              callback_data:
                "admin"
            }
          ]
        ]
      }
    }, env);

    return true;
  }

  return false;
}


/* =====================================================
   HOMEWORK DELETE / ARCHIVE / COPY
===================================================== */

async function deleteHomework(
  chatId,
  telegramId,
  id,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  await env.DB.prepare(
    `DELETE FROM homework
     WHERE id = ?`
  )
    .bind(id)
    .run();

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `🗑 ДЗ №${id} удалено.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📋 Список ДЗ",
            callback_data:
              "hw_admin_list"
          }
        ],
        [
          {
            text: "◀️ Назад",
            callback_data:
              "admin_homework"
          }
        ]
      ]
    }
  }, env);
}


async function archiveHomework(
  chatId,
  telegramId,
  id,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  await env.DB.prepare(
    `UPDATE homework
     SET
       is_archived = 1,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(id)
    .run();

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📦 ДЗ №${id} отправлено в архив.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📋 Список ДЗ",
            callback_data:
              "hw_admin_list"
          }
        ],
        [
          {
            text: "◀️ Назад",
            callback_data:
              "admin_homework"
          }
        ]
      ]
    }
  }, env);
}


async function beginHomeworkCopy(
  chatId,
  telegramId,
  id,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const hw =
    await env.DB.prepare(
      `SELECT *
       FROM homework
       WHERE id = ?`
    )
      .bind(id)
      .first();

  if (!hw) return;

  await beginPendingInput(
    telegramId,
    "hw_copy",
    {
      id
    },
    env
  );

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📋 Копирование ДЗ №${id}\n\n` +
      `Введи новую дату:\n\n` +
      `ДД.ММ.ГГГГ`
  }, env);
}


async function processHomeworkCopy(
  message,
  telegramId,
  text,
  state,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await clearPendingInput(
      telegramId,
      env
    );

    return true;
  }

  const date =
    parseRussianDate(text);

  if (!date) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        "❗ Используй формат ДД.ММ.ГГГГ."
    }, env);

    return true;
  }

  const hw =
    await env.DB.prepare(
      `SELECT *
       FROM homework
       WHERE id = ?`
    )
      .bind(state.data.id)
      .first();

  if (!hw) {
    await clearPendingInput(
      telegramId,
      env
    );

    return true;
  }

  await env.DB.prepare(
    `INSERT INTO homework
     (
       lesson_date,
       subject,
       text,
       lesson_number,
       added_by
     )
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      date,
      hw.subject,
      hw.text,
      hw.lesson_number,
      telegramId
    )
    .run();

  await clearPendingInput(
    telegramId,
    env
  );

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text:
      `✅ ДЗ скопировано!\n\n` +
      `📅 ${formatDate(date)}\n` +
      `📚 ${hw.subject}`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📋 Список ДЗ",
            callback_data:
              "hw_admin_list"
          }
        ]
      ]
    }
  }, env);

  return true;
}


/* =====================================================
   ADMIN SCHEDULE MENU
===================================================== */

async function showAdminSchedule(
  chatId,
  telegramId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⛔ Нет доступа."
    }, env);

    return;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📅 Управление расписанием\n\n` +
      `Выбери день, который хочешь изменить:`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Понедельник",
            callback_data:
              "sch_day_1"
          },
          {
            text: "Вторник",
            callback_data:
              "sch_day_2"
          }
        ],
        [
          {
            text: "Среда",
            callback_data:
              "sch_day_3"
          },
          {
            text: "Четверг",
            callback_data:
              "sch_day_4"
          }
        ],
        [
          {
            text: "Пятница",
            callback_data:
              "sch_day_5"
          }
        ],
        [
          {
            text: "➕ Добавить пару",
            callback_data:
              "sch_admin_add"
          }
        ],
        [
          {
            text: "◀️ В админ-панель",
            callback_data:
              "admin"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   ADMIN SCHEDULE DAY
===================================================== */

async function showAdminScheduleDay(
  chatId,
  telegramId,
  day,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const dayNames = {
    1: "Понедельник",
    2: "Вторник",
    3: "Среда",
    4: "Четверг",
    5: "Пятница"
  };

  if (!dayNames[day]) {
    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         id,
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
      .bind(
        day,
        ACADEMIC_YEAR
      )
      .all();

  const rows =
    result.results || [];

  let text =
    `📅 ${dayNames[day]}\n\n`;

  if (!rows.length) {
    text +=
      `Уроков пока нет.\n`;
  } else {
    for (const lesson of rows) {
      text +=
        `${lesson.lesson_number}. ` +
        `${lesson.start_time}–${lesson.end_time}\n` +
        `📚 ${lesson.subject}\n` +
        `👨‍🏫 ${lesson.teacher || "—"}\n` +
        `🚪 ${lesson.room || "—"}\n\n`;
    }
  }

  const buttons = [];

  for (const lesson of rows) {
    buttons.push([
      {
        text:
          `✏️ Изменить №${lesson.lesson_number}`,
        callback_data:
          `sch_edit_${lesson.id}`
      },
      {
        text:
          `🗑 Удалить`,
        callback_data:
          `sch_delete_${lesson.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "➕ Добавить пару",
      callback_data:
        "sch_admin_add"
    }
  ]);

  buttons.push([
    {
      text: "📆 Исключение на дату",
      callback_data:
        `sch_exception_${day}`
    }
  ]);

  buttons.push([
    {
      text: "📋 Исключения",
      callback_data:
        `sch_exceptions_${day}`
    }
  ]);

  buttons.push([
    {
      text: "📋 Скопировать день",
      callback_data:
        `sch_copy_${day}`
    }
  ]);

  buttons.push([
    {
      text: "◀️ К дням",
      callback_data:
        "admin_schedule"
    }
  ]);

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard:
        buttons
    }
  }, env);
}


/* =====================================================
   SCHEDULE ADD
===================================================== */

async function beginScheduleAdd(
  chatId,
  telegramId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  await beginPendingInput(
    telegramId,
    "schedule_add",
    {},
    env
  );

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `➕ Добавление пары\n\n` +
      `Отправь одной строкой:\n\n` +
      `День | № | начало | конец | предмет | преподаватель | кабинет\n\n` +
      `Например:\n\n` +
      `1 | 1 | 08:30 | 09:20 | Математика | Пешкова А.В. | 6\n\n` +
      `День:\n` +
      `1 — Пн\n` +
      `2 — Вт\n` +
      `3 — Ср\n` +
      `4 — Чт\n` +
      `5 — Пт`
  }, env);
}


async function processScheduleAdd(
  message,
  telegramId,
  text,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await clearPendingInput(
      telegramId,
      env
    );

    return true;
  }

  const parts =
    text
      .split("|")
      .map(
        x => x.trim()
      );

  if (parts.length < 7) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `❗ Нужно 7 полей:\n\n` +
        `День | № | начало | конец | предмет | преподаватель | кабинет`
    }, env);

    return true;
  }

  const day =
    Number(parts[0]);

  const lesson =
    Number(parts[1]);

  const start =
    parts[2];

  const end =
    parts[3];

  const subject =
    parts[4];

  const teacher =
    parts[5] === "-"
      ? null
      : parts[5];

  const room =
    parts[6] === "-"
      ? null
      : parts[6];

  if (
    !Number.isInteger(day) ||
    day < 1 ||
    day > 5 ||
    !Number.isInteger(lesson) ||
    lesson < 1 ||
    lesson > 20 ||
    !isValidTime(start) ||
    !isValidTime(end) ||
    !subject
  ) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `❗ Проверь данные.\n\n` +
        `День: 1–5\n` +
        `Пара: 1–20\n` +
        `Время: ЧЧ:ММ`
    }, env);

    return true;
  }

  const exists =
    await env.DB.prepare(
      `SELECT id
       FROM schedule
       WHERE day_of_week = ?
         AND lesson_number = ?
         AND academic_year = ?`
    )
      .bind(
        day,
        lesson,
        ACADEMIC_YEAR
      )
      .first();

  if (exists) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `❗ На этот день и номер пары уже есть урок.\n\n` +
        `Используй кнопку «Изменить».`
    }, env);

    return true;
  }

  await env.DB.prepare(
    `INSERT INTO schedule
     (
       day_of_week,
       lesson_number,
       start_time,
       end_time,
       subject,
       teacher,
       room,
       academic_year
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      day,
      lesson,
      start,
      end,
      subject,
      teacher,
      room,
      ACADEMIC_YEAR
    )
    .run();

  await clearPendingInput(
    telegramId,
    env
  );

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text:
      `✅ Пара добавлена в основное расписание!\n\n` +
      `📅 ${dayName(day)}\n` +
      `🔢 Пара №${lesson}\n` +
      `⏰ ${start}–${end}\n` +
      `📚 ${subject}\n` +
      `👨‍🏫 ${teacher || "—"}\n` +
      `🚪 ${room || "—"}`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📅 Расписание",
            callback_data:
              "admin_schedule"
          }
        ],
        [
          {
            text: "◀️ Админ-панель",
            callback_data:
              "admin"
          }
        ]
      ]
    }
  }, env);

  return true;
}


/* =====================================================
   SCHEDULE EDIT
===================================================== */

async function beginScheduleEdit(
  chatId,
  telegramId,
  id,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const lesson =
    await env.DB.prepare(
      `SELECT *
       FROM schedule
       WHERE id = ?`
    )
      .bind(id)
      .first();

  if (!lesson) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        "❗ Пара не найдена."
    }, env);

    return;
  }

  await beginPendingInput(
    telegramId,
    "schedule_edit",
    {
      id
    },
    env
  );

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `✏️ Изменение пары №${lesson.lesson_number}\n\n` +
      `Отправь новую информацию:\n\n` +
      `№ | начало | конец | предмет | преподаватель | кабинет\n\n` +
      `Например:\n\n` +
      `2 | 09:30 | 10:20 | Физика | Атанесян Г.А. | 18`
  }, env);
}


async function processScheduleEdit(
  message,
  telegramId,
  text,
  state,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await clearPendingInput(
      telegramId,
      env
    );

    return true;
  }

  const parts =
    text
      .split("|")
      .map(
        x => x.trim()
      );

  if (parts.length < 6) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        `❗ Нужно:\n\n` +
        `№ | начало | конец | предмет | преподаватель | кабинет`
    }, env);

    return true;
  }

  const lesson =
    Number(parts[0]);

  const start =
    parts[1];

  const end =
    parts[2];

  const subject =
    parts[3];

  const teacher =
    parts[4] === "-"
      ? null
      : parts[4];

  const room =
    parts[5] === "-"
      ? null
      : parts[5];

  if (
    !Number.isInteger(lesson) ||
    lesson < 1 ||
    lesson > 20 ||
    !isValidTime(start) ||
    !isValidTime(end) ||
    !subject
  ) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        "❗ Проверь номер пары и время."
    }, env);

    return true;
  }

  await env.DB.prepare(
    `UPDATE schedule
     SET
       lesson_number = ?,
       start_time = ?,
       end_time = ?,
       subject = ?,
       teacher = ?,
       room = ?
     WHERE id = ?`
  )
    .bind(
      lesson,
      start,
      end,
      subject,
      teacher,
      room,
      state.data.id
    )
    .run();

  await clearPendingInput(
    telegramId,
    env
  );

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text:
      `✅ Пара изменена!`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text:
              "📅 Управление расписанием",
            callback_data:
              "admin_schedule"
          }
        ]
      ]
    }
  }, env);

  return true;
}


/* =====================================================
   SCHEDULE DELETE
===================================================== */

async function deleteScheduleLesson(
  chatId,
  telegramId,
  id,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const lesson =
    await env.DB.prepare(
      `SELECT *
       FROM schedule
       WHERE id = ?`
    )
      .bind(id)
      .first();

  if (!lesson) return;

  await env.DB.prepare(
    `DELETE FROM schedule
     WHERE id = ?`
  )
    .bind(id)
    .run();

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `🗑 Пара удалена из основного расписания.\n\n` +
      `📚 ${lesson.subject}\n` +
      `🔢 Пара №${lesson.lesson_number}`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📅 Расписание",
            callback_data:
              "admin_schedule"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   SCHEDULE EXCEPTION
===================================================== */

async function beginScheduleException(
  chatId,
  telegramId,
  day,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  await beginPendingInput(
    telegramId,
    "schedule_exception",
    {
      day
    },
    env
  );

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📆 Исключение на конкретную дату\n\n` +
      `Это НЕ изменит обычное расписание.\n\n` +
      `Отправь:\n\n` +
      `ДД.ММ.ГГГГ | № | начало | конец | предмет | преподаватель | кабинет\n\n` +
      `Например:\n\n` +
      `15.09.2026 | 2 | 09:30 | 10:20 | Физика | Атанесян Г.А. | 18\n\n` +
      `Чтобы удалить пару только в этот день:\n\n` +
      `15.09.2026 | 2 | УДАЛИТЬ`
  }, env);
}


async function processScheduleException(
  message,
  telegramId,
  text,
  state,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await clearPendingInput(
      telegramId,
      env
    );

    return true;
  }

  const parts =
    text
      .split("|")
      .map(
        x => x.trim()
      );

  if (
    parts.length === 3 &&
    parts[2].toUpperCase() ===
      "УДАЛИТЬ"
  ) {
    const date =
      parseRussianDate(
        parts[0]
      );

    const lesson =
      Number(parts[1]);

    if (
      !date ||
      !Number.isInteger(
        lesson
      )
    ) {
      await telegram("sendMessage", {
        chat_id:
          message.chat.id,
        text:
          "❗ Проверь дату и номер пары."
      }, env);

      return true;
    }

    await env.DB.prepare(
      `INSERT OR REPLACE INTO schedule_exceptions
       (
         lesson_date,
         lesson_number,
         action,
         created_by
       )
       VALUES (?, ?, 'delete', ?)`
    )
      .bind(
        date,
        lesson,
        telegramId
      )
      .run();

    await clearPendingInput(
      telegramId,
      env
    );

    await telegram("sendMessage", {
      chat_id:
        message.chat.id,
      text:
        `✅ Пара удалена только на ${formatDate(date)}.`
    }, env);

    return true;
  }

  if (parts.length < 7) {
    await telegram("sendMessage", {
      chat_id:
        message.chat.id,
      text:
        `❗ Формат:\n\n` +
        `ДД.ММ.ГГГГ | № | начало | конец | предмет | преподаватель | кабинет`
    }, env);

    return true;
  }

  const date =
    parseRussianDate(
      parts[0]
    );

  const lesson =
    Number(parts[1]);

  const start =
    parts[2];

  const end =
    parts[3];

  const subject =
    parts[4];

  const teacher =
    parts[5] === "-"
      ? null
      : parts[5];

  const room =
    parts[6] === "-"
      ? null
      : parts[6];

  if (
    !date ||
    !Number.isInteger(
      lesson
    ) ||
    lesson < 1 ||
    lesson > 20 ||
    !isValidTime(start) ||
    !isValidTime(end) ||
    !subject
  ) {
    await telegram("sendMessage", {
      chat_id:
        message.chat.id,
      text:
        "❗ Проверь дату, номер и время."
    }, env);

    return true;
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
      lesson,
      start,
      end,
      subject,
      teacher,
      room,
      telegramId
    )
    .run();

  await clearPendingInput(
    telegramId,
    env
  );

  await telegram("sendMessage", {
    chat_id:
      message.chat.id,
    text:
      `✅ Расписание изменено только на ${formatDate(date)}.\n\n` +
      `📚 ${subject}\n` +
      `⏰ ${start}–${end}\n` +
      `🚪 ${room || "—"}`
  }, env);

  return true;
}


/* =====================================================
   SCHEDULE EXCEPTIONS LIST
===================================================== */

async function showScheduleExceptions(
  chatId,
  telegramId,
  day,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         id,
         lesson_date,
         lesson_number,
         subject,
         action
       FROM schedule_exceptions
       ORDER BY
         lesson_date ASC,
         lesson_number ASC
       LIMIT 100`
    ).all();

  const rows =
    result.results || [];

  if (!rows.length) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `📆 Исключений пока нет.`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "◀️ Назад",
              callback_data:
                `sch_day_${day}`
            }
          ]
        ]
      }
    }, env);

    return;
  }

  let text =
    `📆 Исключения расписания\n\n`;

  const buttons = [];

  for (
    const row
    of rows
  ) {
    text +=
      `🆔 ${row.id}\n` +
      `📅 ${formatDate(row.lesson_date)}\n` +
      `🔢 Пара №${row.lesson_number}\n` +
      `${
        row.action === "delete"
          ? "🗑 Удалена"
          : `📚 ${row.subject || "Изменена"}`
      }\n\n`;

    buttons.push([
      {
        text:
          `🗑 Удалить исключение №${row.id}`,
        callback_data:
          `sch_ex_delete_${row.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "◀️ Назад",
      callback_data:
        `sch_day_${day}`
    }
  ]);

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard:
        buttons
    }
  }, env);
}


async function deleteScheduleException(
  chatId,
  telegramId,
  id,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  await env.DB.prepare(
    `DELETE FROM schedule_exceptions
     WHERE id = ?`
  )
    .bind(id)
    .run();

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `🗑 Исключение №${id} удалено.\n\n` +
      `Обычное расписание снова будет использоваться для этой даты.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📅 Расписание",
            callback_data:
              "admin_schedule"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   COPY SCHEDULE DAY
===================================================== */

async function beginScheduleCopy(
  chatId,
  telegramId,
  sourceDay,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    return;
  }

  await beginPendingInput(
    telegramId,
    "schedule_copy",
    {
      sourceDay
    },
    env
  );

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `📋 Копирование дня\n\n` +
      `Введи номер дня, КУДА скопировать:\n\n` +
      `1 — Понедельник\n` +
      `2 — Вторник\n` +
      `3 — Среда\n` +
      `4 — Четверг\n` +
      `5 — Пятница`
  }, env);
}


async function processScheduleCopy(
  message,
  telegramId,
  text,
  state,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await clearPendingInput(
      telegramId,
      env
    );

    return true;
  }

  const targetDay =
    Number(text);

  const sourceDay =
    Number(
      state.data.sourceDay
    );

  if (
    !Number.isInteger(
      targetDay
    ) ||
    targetDay < 1 ||
    targetDay > 5
  ) {
    await telegram("sendMessage", {
      chat_id:
        message.chat.id,
      text:
        `❗ Введи номер дня от 1 до 5.`
    }, env);

    return true;
  }

  if (
    targetDay ===
    sourceDay
  ) {
    await telegram("sendMessage", {
      chat_id:
        message.chat.id,
      text:
        `❗ Нельзя скопировать день сам в себя.`
    }, env);

    return true;
  }

  const source =
    await env.DB.prepare(
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
      .bind(
        sourceDay,
        ACADEMIC_YEAR
      )
      .all();

  const rows =
    source.results || [];

  await env.DB.prepare(
    `DELETE FROM schedule
     WHERE day_of_week = ?
       AND academic_year = ?`
  )
    .bind(
      targetDay,
      ACADEMIC_YEAR
    )
    .run();

  for (
    const row
    of rows
  ) {
    await env.DB.prepare(
      `INSERT INTO schedule
       (
         day_of_week,
         lesson_number,
         start_time,
         end_time,
         subject,
         teacher,
         room,
         academic_year
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        targetDay,
        row.lesson_number,
        row.start_time,
        row.end_time,
        row.subject,
        row.teacher,
        row.room,
        ACADEMIC_YEAR
      )
      .run();
  }

  await clearPendingInput(
    telegramId,
    env
  );

  await telegram("sendMessage", {
    chat_id:
      message.chat.id,
    text:
      `✅ День скопирован!\n\n` +
      `${dayName(sourceDay)} → ${dayName(targetDay)}\n\n` +
      `Скопировано уроков: ${rows.length}`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text:
              "📅 Управление расписанием",
            callback_data:
              "admin_schedule"
          }
        ]
      ]
    }
  }, env);

  return true;
}


/* =====================================================
   PENDING INPUT
===================================================== */

async function beginPendingInput(
  telegramId,
  action,
  data,
  env
) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO settings
     (key, value)
     VALUES (?, ?)`
  )
    .bind(
      `pending_${telegramId}`,
      JSON.stringify({
        action,
        data: data || {}
      })
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
    .bind(
      `pending_${telegramId}`
    )
    .run();
}


async function getPendingInput(
  telegramId,
  env
) {
  const result =
    await env.DB.prepare(
      `SELECT value
       FROM settings
       WHERE key = ?`
    )
      .bind(
        `pending_${telegramId}`
      )
      .first();

  if (!result) {
    return null;
  }

  try {
    return JSON.parse(
      result.value
    );
  } catch {
    return null;
  }
}


/* =====================================================
   HANDLE PENDING INPUT
===================================================== */

async function handlePendingInput(
  message,
  telegramId,
  text,
  env
) {
  const state =
    await getPendingInput(
      telegramId,
      env
    );

  if (!state) {
    return false;
  }

  if (
    state.action.startsWith(
      "hw_add"
    )
  ) {
    return await processHomeworkAdd(
      message,
      telegramId,
      text,
      state,
      env
    );
  }

  if (
    state.action.startsWith(
      "hw_edit"
    )
  ) {
    return await processHomeworkEdit(
      message,
      telegramId,
      text,
      state,
      env
    );
  }

  if (
    state.action ===
    "hw_copy"
  ) {
    return await processHomeworkCopy(
      message,
      telegramId,
      text,
      state,
      env
    );
  }

  if (
    state.action ===
    "replacement_reason"
  ) {
    const reason =
      text.trim();

    if (!reason) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            message.chat.id,
          text:
            "❌ Причина не может быть пустой.\n\n" +
            "Напиши причину ещё раз."
        },
        env
      );

      return true;
    }

    const dutyDate =
      state.data.duty_date;

    const replacementId =
      Number(
        state.data.replacement_id
      );

    const requester =
      await env.DB.prepare(
        `SELECT id, full_name
         FROM students
         WHERE telegram_id = ?`
      )
        .bind(telegramId)
        .first();

    if (!requester) {
      await clearPendingInput(
        telegramId,
        env
      );

      return true;
    }

    const replacement =
      await env.DB.prepare(
        `SELECT id, full_name, telegram_id
         FROM students
         WHERE id = ?
           AND is_active = 1`
      )
        .bind(replacementId)
        .first();

    if (!replacement) {
      await clearPendingInput(
        telegramId,
        env
      );

      await telegram(
        "sendMessage",
        {
          chat_id:
            message.chat.id,
          text:
            "❌ Участник не найден.",
          reply_markup:
            backMenu()
        },
        env
      );

      return true;
    }

    const existing =
      await env.DB.prepare(
        `SELECT id
         FROM replacements
         WHERE duty_date = ?
           AND requester_id = ?
           AND status IN ('pending', 'accepted')`
      )
        .bind(
          dutyDate,
          requester.id
        )
        .first();

    if (existing) {
      await clearPendingInput(
        telegramId,
        env
      );

      await telegram(
        "sendMessage",
        {
          chat_id:
            message.chat.id,
          text:
            `⚠️ У тебя уже есть активная заявка на замену на ${formatDateRu(dutyDate)}.`,
          reply_markup:
            backMenu()
        },
        env
      );

      return true;
    }

    const result =
      await env.DB.prepare(
        `INSERT INTO replacements
         (
           duty_date,
           requester_id,
           replacement_id,
           reason,
           status
         )
         VALUES (?, ?, ?, ?, 'pending')`
      )
        .bind(
          dutyDate,
          requester.id,
          replacement.id,
          reason
        )
        .run();

    await clearPendingInput(
      telegramId,
      env
    );

    const replacementRecordId =
      result.meta?.last_row_id;

    await telegram(
      "sendMessage",
      {
        chat_id:
          message.chat.id,
        text:
          `✅ Заявка на замену создана!\n\n` +
          `📅 ${formatDateRu(dutyDate)}\n` +
          `👤 Кто просит: ${requester.full_name}\n` +
          `🔄 Кто заменяет: ${replacement.full_name}\n` +
          `📝 Причина: ${reason}\n\n` +
          `⏳ Ожидаем ответ от одногруппника.`,
        reply_markup:
          backMenu()
      },
      env
    );

    if (
      replacement.telegram_id &&
      replacementRecordId
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            replacement.telegram_id,
          text:
            `🔄 Тебе предложили замену!\n\n` +
            `📅 Дата: ${formatDateRu(dutyDate)}\n` +
            `👤 Просит замену: ${requester.full_name}\n` +
            `📝 Причина: ${reason}\n\n` +
            `Согласен выйти за одногруппника?`,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "✅ Принять",
                  callback_data:
                    `replacement_accept_${replacementRecordId}`
                },
                {
                  text:
                    "❌ Отказать",
                  callback_data:
                    `replacement_reject_${replacementRecordId}`
                }
              ]
            ]
          }
        },
        env
      );
    } else {
      await telegram(
        "sendMessage",
        {
          chat_id:
            message.chat.id,
          text:
            `⚠️ Заявка сохранена, но у выбранного участника не привязан Telegram.\n\n` +
            `Он не сможет получить уведомление от бота.`
        },
        env
      );
    }

    return true;
  }

  if (
    state.action ===
    "schedule_add"
  ) {
    return await processScheduleAdd(
      message,
      telegramId,
      text,
      env
    );
  }

  if (
    state.action ===
    "schedule_edit"
  ) {
    return await processScheduleEdit(
      message,
      telegramId,
      text,
      state,
      env
    );
  }

  if (
    state.action ===
    "schedule_exception"
  ) {
    return await processScheduleException(
      message,
      telegramId,
      text,
      state,
      env
    );
  }

  if (
    state.action ===
    "schedule_copy"
  ) {
    return await processScheduleCopy(
      message,
      telegramId,
      text,
      state,
      env
    );
  }

  return false;
}

/* =====================================================
   ADMIN DUTIES
===================================================== */

async function showAdminDuties(
  chatId,
  telegramId,
  env
) {
  if (
    !(await isAdmin(
      telegramId,
      env
    ))
  ) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "⛔ Нет доступа."
    }, env);

    return;
  }

  const result =
    await env.DB.prepare(
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

  let text =
    `🧹 Дежурства\n\n`;

  const rows =
    result.results || [];

  if (!rows.length) {
    text +=
      `Дежурства не найдены.`;
  } else {
    for (
      const duty
      of rows
    ) {
      text +=
        `📅 ${formatDate(duty.duty_date)} — ` +
        `пара №${duty.pair_number}\n` +
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
   DUTY — STUDENT
===================================================== */

async function showDuty(
  chatId,
  telegramId,
  env
) {
  const student =
    await env.DB.prepare(
      `SELECT
         id,
         full_name
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
        `Нажми /start и попроси код у старосты.`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  const today =
    getLocalDate();

  const duty =
    await env.DB.prepare(
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

  const history =
    await env.DB.prepare(
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
    const oldStudent =
      await env.DB.prepare(
        `SELECT full_name
         FROM students
         WHERE id = ?`
      )
        .bind(
          history.old_student_id
        )
        .first();

    const newStudent =
      await env.DB.prepare(
        `SELECT full_name
         FROM students
         WHERE id = ?`
      )
        .bind(
          history.new_student_id
        )
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
            text:
              "🔄 Попросить замену",
            callback_data:
              "replacement"
          }
        ],
        [
          {
            text:
              "◀️ Назад",
            callback_data:
              "back"
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
  const pairs =
    await env.DB.prepare(
      `SELECT
         pair_number,
         student1_id,
         student2_id
       FROM duty_pairs
       WHERE active = 1
       ORDER BY pair_number`
    ).all();

  const pairRows =
    pairs.results || [];

  if (!pairRows.length) {
    console.error(
      "No active duty pairs found"
    );

    return;
  }

  const lastDuty =
    await env.DB.prepare(
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
    currentDate =
      addDays(
        lastDuty.duty_date,
        1
      );

    nextPairNumber =
      Number(
        lastDuty.pair_number
      ) + 1;

    if (
      nextPairNumber >
      pairRows.length
    ) {
      nextPairNumber = 1;
    }
  } else {
    currentDate =
      DUTY_START_DATE;

    nextPairNumber = 1;
  }

  const today =
    getLocalDate();

  const generationEnd =
    addDays(
      today > currentDate
        ? today
        : currentDate,
      DUTY_GENERATE_DAYS
    );

  let generated = 0;

  while (
    currentDate <=
    generationEnd
  ) {
    const day =
      getDayOfWeek(
        currentDate
      );

    if (
      day !== 0 &&
      day !== 6
    ) {
      const calendar =
        await env.DB.prepare(
          `SELECT status
           FROM calendar
           WHERE calendar_date = ?`
        )
          .bind(
            currentDate
          )
          .first();

      const isCalendarDayOff =
        calendar &&
        (
          calendar.status ===
            "holiday" ||
          calendar.status ===
            "vacation" ||
          calendar.status ===
            "cancelled" ||
          calendar.status ===
            "weekend" ||
          calendar.status ===
            "day_off"
        );

      if (!isCalendarDayOff) {
        const existing =
          await env.DB.prepare(
            `SELECT id
             FROM duties
             WHERE duty_date = ?`
          )
            .bind(
              currentDate
            )
            .first();

        if (!existing) {
          const pair =
            pairRows.find(
              p =>
                Number(
                  p.pair_number
                ) ===
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
              pairRows.length
            ) {
              nextPairNumber = 1;
            }
          }
        }
      }
    }

    currentDate =
      addDays(
        currentDate,
        1
      );
  }

  console.log(
    `Duties generated: ${generated}`
  );
}


/* =====================================================
   TODAY DUTY
===================================================== */

async function getTodayDuty(env) {
  const today =
    getLocalDate();

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
  const setting =
    await env.DB.prepare(
      `SELECT value
       FROM settings
       WHERE key = 'group_chat_id'`
    )
      .first();

  if (
    !setting ||
    !setting.value
  ) {
    console.log(
      "Group chat ID not saved yet"
    );

    return false;
  }

  const duty =
    await getTodayDuty(
      env
    );

  if (!duty) {
    return false;
  }

  const today =
    getLocalDate();

  let student1 =
    duty.student1;

  let student2 =
    duty.student2;

  const history =
    await env.DB.prepare(
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

  let replacementText =
    "";

  if (history) {
    const oldStudent =
      await env.DB.prepare(
        `SELECT full_name
         FROM students
         WHERE id = ?`
      )
        .bind(
          history.old_student_id
        )
        .first();

    const newStudent =
      await env.DB.prepare(
        `SELECT full_name
         FROM students
         WHERE id = ?`
      )
        .bind(
          history.new_student_id
        )
        .first();

    if (
      oldStudent &&
      newStudent
    ) {
      if (
        student1 ===
        oldStudent.full_name
      ) {
        student1 =
          newStudent.full_name;
      }

      if (
        student2 ===
        oldStudent.full_name
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

  if (
    type ===
    "morning"
  ) {
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

  const result =
    await telegram(
      "sendMessage",
      {
        chat_id:
          setting.value,
        text
      },
      env
    );

  return !!result.ok;
}


/* =====================================================
   SCHEDULED TASKS
===================================================== */

async function runScheduledTasks(
  env
) {
  try {
    await generateDuties(
      env
    );

    const now =
      getLocalTime();

    const today =
      getLocalDate();

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

      if (
        enabled !== "0"
      ) {
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
          setting.value !==
            today
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
              .bind(
                key,
                today
              )
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

      if (
        enabled !== "0"
      ) {
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
          setting.value !==
            today
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
              .bind(
                key,
                today
              )
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

  return result?.value ||
    null;
}


/* =====================================================
   DATE / TIME
===================================================== */

function getLocalDate() {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          TIMEZONE,
        year:
          "numeric",
        month:
          "2-digit",
        day:
          "2-digit"
      }
    )
      .formatToParts(
        new Date()
      );

  const year =
    parts.find(
      p =>
        p.type ===
        "year"
    ).value;

  const month =
    parts.find(
      p =>
        p.type ===
        "month"
    ).value;

  const day =
    parts.find(
      p =>
        p.type ===
        "day"
    ).value;

  return (
    `${year}-${month}-${day}`
  );
}


function getLocalTime() {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          TIMEZONE,
        hour:
          "2-digit",
        minute:
          "2-digit",
        hour12:
          false
      }
    )
      .formatToParts(
        new Date()
      );

  let hour =
    Number(
      parts.find(
        p =>
          p.type ===
          "hour"
      ).value
    );

  const minute =
    Number(
      parts.find(
        p =>
          p.type ===
          "minute"
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


function getDayOfWeek(
  dateString
) {
  const [
    year,
    month,
    day
  ] =
    dateString
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
  ] =
    dateString
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
    date.getUTCDate() +
    days
  );

  return date
    .toISOString()
    .slice(0, 10);
}


function formatDate(date) {
  if (!date) return "";

  const parts =
    date.split("-");

  if (
    parts.length !== 3
  ) {
    return date;
  }

  return (
    `${parts[2]}.` +
    `${parts[1]}.` +
    `${parts[0]}`
  );
}


function parseRussianDate(
  value
) {
  if (!value) {
    return null;
  }

  const match =
    value.match(
      /^(\d{2})\.(\d{2})\.(\d{4})$/
    );

  if (!match) {
    return null;
  }

  const day =
    Number(match[1]);

  const month =
    Number(match[2]);

  const year =
    Number(match[3]);

  const date =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day
      )
    );

  if (
    date.getUTCFullYear() !==
      year ||
    date.getUTCMonth() !==
      month - 1 ||
    date.getUTCDate() !==
      day
  ) {
    return null;
  }

  return (
    `${year
      .toString()
      .padStart(4, "0")}-` +
    `${month
      .toString()
      .padStart(2, "0")}-` +
    `${day
      .toString()
      .padStart(2, "0")}`
  );
}


function timeToMinutes(
  time
) {
  if (!time) {
    return 0;
  }

  const parts =
    time
      .split(":")
      .map(Number);

  return (
    parts[0] * 60 +
    parts[1]
  );
}


function isValidTime(
  time
) {
  if (
    !/^\d{2}:\d{2}$/.test(
      time
    )
  ) {
    return false;
  }

  const [
    hour,
    minute
  ] =
    time
      .split(":")
      .map(Number);

  return (
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59
  );
}


function dayName(day) {
  const names = {
    1: "Понедельник",
    2: "Вторник",
    3: "Среда",
    4: "Четверг",
    5: "Пятница"
  };

  return (
    names[day] ||
    "Неизвестный день"
  );
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
      `Этот раздел пока находится в разработке.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text:
              "◀️ В админ-панель",
            callback_data:
              "admin"
          }
        ]
      ]
    }
  }, env);
}


/* =====================================================
   BACK
===================================================== */

function backMenu() {
  return {
    inline_keyboard: [
      [
        {
          text:
            "◀️ Назад",
          callback_data:
            "back"
        }
      ]
    ]
  };
}
async function beginReplacement(
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
        `❌ Сначала привяжи свой Telegram к участнику группы.`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  const duty = await env.DB.prepare(
    `SELECT
       id,
       duty_date,
       student1_id,
       student2_id,
       status
     FROM duties
     WHERE duty_date >= date('now', 'localtime')
       AND status = 'scheduled'
       AND (
         student1_id = ?
         OR student2_id = ?
       )
     ORDER BY duty_date ASC
     LIMIT 1`
  )
    .bind(student.id, student.id)
    .first();

  if (!duty) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `🧹 У тебя сейчас нет ближайшего запланированного дежурства, для которого можно запросить замену.`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  const partnerId =
    Number(duty.student1_id) === Number(student.id)
      ? duty.student2_id
      : duty.student1_id;

  const students = await env.DB.prepare(
    `SELECT id, full_name
     FROM students
     WHERE is_active = 1
       AND id != ?
       AND id != ?
     ORDER BY full_name`
  )
    .bind(student.id, partnerId)
    .all();

  const buttons = [];

  for (const person of students.results || []) {
    buttons.push([
      {
        text: person.full_name,
        callback_data:
          `replacement_select_${person.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "◀️ Назад",
      callback_data: "duty"
    }
  ]);

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `🔄 Попросить замену\n\n` +
      `📅 Дата дежурства: ${formatDateRu(duty.duty_date)}\n\n` +
      `Выбери человека, которого хочешь попросить выйти за тебя:`,
    reply_markup: {
      inline_keyboard: buttons
    }
  }, env);
}
async function selectReplacementPerson(
  chatId,
  telegramId,
  replacementId,
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
    return;
  }

  const duty = await env.DB.prepare(
    `SELECT
       id,
       duty_date,
       student1_id,
       student2_id
     FROM duties
     WHERE duty_date >= date('now', 'localtime')
       AND status = 'scheduled'
       AND (
         student1_id = ?
         OR student2_id = ?
       )
     ORDER BY duty_date ASC
     LIMIT 1`
  )
    .bind(student.id, student.id)
    .first();

  if (!duty) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "❌ Ближайшее дежурство не найдено.",
      reply_markup: backMenu()
    }, env);

    return;
  }

  const replacement = await env.DB.prepare(
    `SELECT id, full_name
     FROM students
     WHERE id = ?
       AND is_active = 1`
  )
    .bind(replacementId)
    .first();

  if (!replacement) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "❌ Участник не найден.",
      reply_markup: backMenu()
    }, env);

    return;
  }

  await beginPendingInput(
    telegramId,
    "replacement_reason",
    {
      duty_date: duty.duty_date,
      replacement_id: replacement.id
    },
    env
  );

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `🔄 Замена на ${formatDateRu(duty.duty_date)}\n\n` +
      `👤 Заменить тебя должен:\n${replacement.full_name}\n\n` +
      `📝 Теперь напиши причину, почему тебе нужна замена.\n\n` +
      `Например: заболел, не смогу прийти, семейные обстоятельства.\n\n` +
      `Для отмены: /cancel`
  }, env);
}
async function answerReplacement(
  chatId,
  telegramId,
  replacementId,
  accepted,
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
    return;
  }

  const replacement = await env.DB.prepare(
    `SELECT
       r.*,
       requester.full_name AS requester_name,
       replacement.full_name AS replacement_name,
       requester.telegram_id AS requester_telegram_id
     FROM replacements r
     JOIN students requester
       ON requester.id = r.requester_id
     JOIN students replacement
       ON replacement.id = r.replacement_id
     WHERE r.id = ?
       AND r.replacement_id = ?`
  )
    .bind(replacementId, student.id)
    .first();

  if (!replacement) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "❌ Заявка не найдена или она адресована не тебе.",
      reply_markup: backMenu()
    }, env);

    return;
  }

  if (replacement.status !== "pending") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `ℹ️ Эта заявка уже обработана.\n\n` +
        `Статус: ${replacement.status}`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  const newStatus = accepted
    ? "accepted"
    : "rejected";

  await env.DB.prepare(
    `UPDATE replacements
     SET status = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(newStatus, replacementId)
    .run();

  if (!accepted) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❌ Ты отказался от замены.\n\n` +
        `Заявка отменена.`,
      reply_markup: backMenu()
    }, env);

    if (replacement.requester_telegram_id) {
      await telegram("sendMessage", {
        chat_id: replacement.requester_telegram_id,
        text:
          `❌ ${student.full_name} отказался заменить тебя ` +
          `на ${formatDateRu(replacement.duty_date)}.`
      }, env);
    }

    return;
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `✅ Ты согласился на замену.\n\n` +
      `⏳ Теперь заявка отправлена старосте или заместителю на подтверждение.`,
    reply_markup: backMenu()
  }, env);

  if (replacement.requester_telegram_id) {
    await telegram("sendMessage", {
      chat_id: replacement.requester_telegram_id,
      text:
        `✅ ${student.full_name} согласился тебя заменить!\n\n` +
        `⏳ Теперь ждём подтверждение старосты или заместителя.`
    }, env);
  }

  await notifyAdminsAboutReplacement(
    replacementId,
    env
  );
}
async function notifyAdminsAboutReplacement(
  replacementId,
  env
) {
  const replacement = await env.DB.prepare(
    `SELECT
       r.*,
       requester.full_name AS requester_name,
       replacement.full_name AS replacement_name
     FROM replacements r
     JOIN students requester
       ON requester.id = r.requester_id
     JOIN students replacement
       ON replacement.id = r.replacement_id
     WHERE r.id = ?`
  )
    .bind(replacementId)
    .first();

  if (!replacement) return;

  const admins = await env.DB.prepare(
    `SELECT telegram_id
     FROM students
     WHERE role IN ('admin', 'deputy')
       AND telegram_id IS NOT NULL
       AND is_active = 1`
  ).all();

  for (const admin of admins.results || []) {
    await telegram("sendMessage", {
      chat_id: admin.telegram_id,
      text:
        `🔄 Новая заявка на замену\n\n` +
        `📅 ${formatDateRu(replacement.duty_date)}\n` +
        `👤 Просит замену: ${replacement.requester_name}\n` +
        `🔄 Заменяет: ${replacement.replacement_name}\n` +
        `📝 Причина: ${replacement.reason}\n\n` +
        `Участник согласился. Требуется подтверждение.`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Одобрить",
              callback_data:
                `replacement_approve_${replacement.id}`
            }
          ]
        ]
      }
    }, env);
  }
}
async function approveReplacement(
  chatId,
  telegramId,
  replacementId,
  env
) {
  if (!(await isAdmin(telegramId, env))) {
    return;
  }

  const replacement = await env.DB.prepare(
    `SELECT
       r.*,
       requester.full_name AS requester_name,
       requester.telegram_id AS requester_telegram_id,
       replacement.full_name AS replacement_name,
       replacement.telegram_id AS replacement_telegram_id
     FROM replacements r
     JOIN students requester
       ON requester.id = r.requester_id
     JOIN students replacement
       ON replacement.id = r.replacement_id
     WHERE r.id = ?`
  )
    .bind(replacementId)
    .first();

  if (!replacement) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "❌ Заявка не найдена.",
      reply_markup: backMenu()
    }, env);

    return;
  }

  if (replacement.status !== "accepted") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `⚠️ Эту заявку нельзя одобрить.\n\n` +
        `Текущий статус: ${replacement.status}`,
      reply_markup: backMenu()
    }, env);

    return;
  }

  await env.DB.prepare(
    `UPDATE replacements
     SET status = 'approved',
         approved_by = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(telegramId, replacementId)
    .run();

  /*
     Меняем фактического дежурного только после
     окончательного одобрения админом.
  */
  const duty = await env.DB.prepare(
    `SELECT *
     FROM duties
     WHERE duty_date = ?`
  )
    .bind(replacement.duty_date)
    .first();

  if (duty) {
    let updateQuery = null;

    if (
      Number(duty.student1_id) ===
      Number(replacement.requester_id)
    ) {
      updateQuery =
        `UPDATE duties
         SET student1_id = ?
         WHERE id = ?`;
    } else if (
      Number(duty.student2_id) ===
      Number(replacement.requester_id)
    ) {
      updateQuery =
        `UPDATE duties
         SET student2_id = ?
         WHERE id = ?`;
    }

    if (updateQuery) {
      await env.DB.prepare(updateQuery)
        .bind(
          replacement.replacement_id,
          duty.id
        )
        .run();

      await env.DB.prepare(
        `INSERT INTO duty_history
         (
           duty_id,
           old_student_id,
           new_student_id,
           reason,
           changed_by
         )
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          duty.id,
          replacement.requester_id,
          replacement.replacement_id,
          replacement.reason,
          telegramId
        )
        .run();
    }
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `✅ Замена одобрена!\n\n` +
      `📅 ${formatDateRu(replacement.duty_date)}\n` +
      `👤 ${replacement.requester_name}\n` +
      `🔄 ${replacement.replacement_name}\n\n` +
      `Теперь замена считается официальной.`,
    reply_markup: backMenu()
  }, env);

  if (replacement.requester_telegram_id) {
    await telegram("sendMessage", {
      chat_id: replacement.requester_telegram_id,
      text:
        `🎉 Замена подтверждена!\n\n` +
        `📅 ${formatDateRu(replacement.duty_date)}\n` +
        `🔄 Тебя заменит ${replacement.replacement_name}.\n\n` +
        `Староста подтвердил замену.`
    }, env);
  }

  if (replacement.replacement_telegram_id) {
    await telegram("sendMessage", {
      chat_id: replacement.replacement_telegram_id,
      text:
        `✅ Замена официально подтверждена!\n\n` +
        `📅 ${formatDateRu(replacement.duty_date)}\n` +
        `Теперь ты дежуришь вместо ${replacement.requester_name}.`
    }, env);
  }
}
