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

  /*
     Сохраняем ID группы
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

    if (linked) {
      return;
    }
  }

  /*
     Все остальные текстовые действия
     обрабатываются здесь.
  */
  const handled = await handlePendingInput(
    message,
    env
  );

  if (handled) {
    return;
  }

  /*
     В группе бот не показывает личное меню.
  */
  if (
    message.chat &&
    (
      message.chat.type === "group" ||
      message.chat.type === "supergroup"
    )
  ) {
    return;
  }

  /*
     Если пользователь написал что-то обычное
     в личном чате — показываем меню.
  */
  await showMainMenu(
    message.chat.id,
    telegramId,
    env
  );
}


/* =====================================================
   START
===================================================== */

async function startCommand(message, env) {
  const telegramId = message.from.id;
  const chatId = message.chat.id;

  /*
     Если пользователь уже существует —
     обновляем username.
  */
  const existing =
    await env.DB.prepare(
      `SELECT id, full_name, role
       FROM students
       WHERE telegram_id = ?`
    )
      .bind(telegramId)
      .first();

  if (existing) {
    await env.DB.prepare(
      `UPDATE students
       SET username = ?
       WHERE id = ?`
    )
      .bind(
        message.from.username
          ? `@${message.from.username}`
          : null,
        existing.id
      )
      .run();
  }

  /*
     Главное меню показываем только в личном чате.
  */
  if (
    message.chat.type === "private"
  ) {
    await showMainMenu(
      chatId,
      telegramId,
      env
    );
    return;
  }

  /*
     В группе ничего лишнего не отправляем.
  */
}


/* =====================================================
   MAIN MENU
===================================================== */

async function showMainMenu(
  chatId,
  telegramId,
  env
) {
  const admin =
    await isAdmin(
      telegramId,
      env
    );

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
        callback_data: "lateness"
      }
    ]
  ];

  if (admin) {
    keyboard.push([
      {
        text: "👑 Админ-панель",
        callback_data: "admin"
      }
    ]);
  }

  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      `✨ <b>Помощник ПК-38</b>\n\n` +
      `Добро пожаловать!\n` +
      `Выбери нужный раздел ниже 👇`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: keyboard
    }
  }, env);
}


/* =====================================================
   BACK MENU
===================================================== */

function backMenu(callback = "menu") {
  return {
    inline_keyboard: [
      [
        {
          text: "◀️ Назад",
          callback_data: callback
        }
      ]
    ]
  };
}


/* =====================================================
   ADMIN CHECK
===================================================== */

async function isAdmin(
  telegramId,
  env
) {
  const student =
    await env.DB.prepare(
      `SELECT role
       FROM students
       WHERE telegram_id = ?
         AND is_active = 1`
    )
      .bind(telegramId)
      .first();

  if (!student) {
    return false;
  }

  return (
    student.role === "admin" ||
    student.role === "deputy"
  );
}


/* =====================================================
   ADMIN ONLY
===================================================== */

async function isMainAdmin(
  telegramId,
  env
) {
  const student =
    await env.DB.prepare(
      `SELECT role
       FROM students
       WHERE telegram_id = ?
         AND is_active = 1`
    )
      .bind(telegramId)
      .first();

  return (
    student &&
    student.role === "admin"
  );
}
/* =====================================================
   DATE / TIME
===================================================== */

function getLocalDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function getLocalTime() {
  const parts =
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(new Date());

  const hour =
    Number(
      parts.find(
        part => part.type === "hour"
      )?.value || 0
    );

  const minute =
    Number(
      parts.find(
        part => part.type === "minute"
      )?.value || 0
    );

  return {
    hour,
    minute
  };
}

function getDayOfWeek(dateString) {
  const date =
    new Date(`${dateString}T12:00:00`);

  return date.getDay();
}

function formatDate(dateString) {
  if (!dateString) {
    return "";
  }

  const parts =
    dateString.split("-");

  if (parts.length !== 3) {
    return dateString;
  }

  return (
    `${parts[2]}.${parts[1]}.${parts[0]}`
  );
}

function formatDateRu(dateString) {
  return formatDate(dateString);
}


/* =====================================================
   DATE HELPERS
===================================================== */

function addDays(
  dateString,
  amount
) {
  const date =
    new Date(
      `${dateString}T12:00:00`
    );

  date.setDate(
    date.getDate() + amount
  );

  return date
    .toISOString()
    .slice(0, 10);
}

function isWeekend(dateString) {
  const day =
    getDayOfWeek(dateString);

  return (
    day === 0 ||
    day === 6
  );
}

function getWeekDates(
  dateString
) {
  const date =
    new Date(
      `${dateString}T12:00:00`
    );

  const day =
    date.getDay();

  const mondayOffset =
    day === 0
      ? -6
      : 1 - day;

  date.setDate(
    date.getDate() +
    mondayOffset
  );

  const result = [];

  for (let i = 0; i < 7; i++) {
    const current =
      new Date(date);

    current.setDate(
      date.getDate() + i
    );

    result.push(
      current
        .toISOString()
        .slice(0, 10)
    );
  }

  return result;
}


/* =====================================================
   SCHEDULE
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
      .map(lesson => ({
        ...lesson
      }));

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
   SHOW SCHEDULE
===================================================== */

async function showSchedule(
  chatId,
  telegramId,
  env
) {
  const today =
    getLocalDate();

  const dates =
    getWeekDates(today);

  let text =
    `📅 <b>Расписание</b>\n\n`;

  const dayNames = [
    "Вс",
    "Пн",
    "Вт",
    "Ср",
    "Чт",
    "Пт",
    "Сб"
  ];

  for (
    const date
    of dates
  ) {
    const day =
      getDayOfWeek(date);

    if (
      day === 0 ||
      day === 6
    ) {
      continue;
    }

    const lessons =
      await getScheduleForDate(
        date,
        day,
        env
      );

    text +=
      `📌 <b>${dayNames[day]} ${formatDate(date)}</b>\n`;

    if (!lessons.length) {
      text +=
        `Нет занятий\n\n`;
      continue;
    }

    for (
      const lesson
      of lessons
    ) {
      text +=
        `${lesson.lesson_number}. ` +
        `${lesson.start_time}–${lesson.end_time} ` +
        `${lesson.subject}`;

      if (lesson.teacher) {
        text +=
          ` — ${lesson.teacher}`;
      }

      if (lesson.room) {
        text +=
          ` · каб. ${lesson.room}`;
      }

      text += "\n";
    }

    text += "\n";
  }

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⚡ Что сейчас?",
              callback_data:
                "current_lesson"
            }
          ],
          [
            {
              text: "◀️ Назад",
              callback_data:
                "menu"
            }
          ]
        ]
      }
    },
    env
  );
}


/* =====================================================
   TODAY
===================================================== */

async function showToday(
  chatId,
  telegramId,
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
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `☀️ <b>Сегодня</b>\n\n` +
          `Сегодня выходной 😌`,
        parse_mode: "HTML",
        reply_markup:
          backMenu()
      },
      env
    );

    return;
  }

  const lessons =
    await getScheduleForDate(
      date,
      day,
      env
    );

  const duty =
    await getDutyForDate(
      date,
      env
    );

  let text =
    `☀️ <b>Сегодня, ${formatDate(date)}</b>\n\n`;

  if (lessons.length) {
    text +=
      `📚 <b>Занятия</b>\n`;

    for (
      const lesson
      of lessons
    ) {
      text +=
        `${lesson.lesson_number}. ` +
        `${lesson.start_time}–${lesson.end_time} — ` +
        `${lesson.subject}`;

      if (lesson.room) {
        text +=
          ` · ${lesson.room}`;
      }

      text += "\n";
    }
  } else {
    text +=
      `📚 Занятий сегодня нет.\n`;
  }

  text += "\n";

  if (duty) {
    text +=
      `🧹 <b>Дежурство</b>\n` +
      `${duty.student1_name} + ` +
      `${duty.student2_name}\n`;
  } else {
    text +=
      `🧹 Дежурство сегодня не назначено.\n`;
  }

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⚡ Что сейчас?",
              callback_data:
                "current_lesson"
            }
          ],
          [
            {
              text: "📅 Расписание",
              callback_data:
                "schedule"
            }
          ],
          [
            {
              text: "◀️ Назад",
              callback_data:
                "menu"
            }
          ]
        ]
      }
    },
    env
  );
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
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⚡ <b>Сейчас занятий нет</b>\n\n` +
          `Сегодня выходной.`,
        parse_mode: "HTML",
        reply_markup:
          backMenu("today")
      },
      env
    );

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

  for (
    const lesson
    of lessons
  ) {
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
    `⚡ <b>Что сейчас?</b>\n\n`;

  if (current) {
    text +=
      `🔴 <b>Сейчас идёт:</b>\n` +
      `${current.subject}\n` +
      `🕐 ${current.start_time}–${current.end_time}\n`;

    if (current.teacher) {
      text +=
        `👨‍🏫 ${current.teacher}\n`;
    }

    if (current.room) {
      text +=
        `🚪 Каб. ${current.room}\n`;
    }

    if (next) {
      text +=
        `\n➡️ <b>Следующее:</b> ` +
        `${next.subject} ` +
        `(${next.start_time})`;
    }
  } else if (next) {
    text +=
      `🟢 Сейчас урока нет.\n\n` +
      `➡️ Следующее занятие:\n` +
      `${next.subject}\n` +
      `🕐 ${next.start_time}–${next.end_time}`;

    if (next.room) {
      text +=
        `\n🚪 Каб. ${next.room}`;
    }
  } else {
    text +=
      `🏠 На сегодня занятия уже закончились.`;
  }

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📅 Расписание",
              callback_data:
                "schedule"
            }
          ],
          [
            {
              text: "◀️ Назад",
              callback_data:
                "menu"
            }
          ]
        ]
      }
    },
    env
  );
}


/* =====================================================
   TIME TO MINUTES
===================================================== */

function timeToMinutes(
  value
) {
  if (!value) {
    return 0;
  }

  const parts =
    String(value)
      .split(":")
      .map(Number);

  return (
    (parts[0] || 0) * 60 +
    (parts[1] || 0)
  );
}


/* =====================================================
   DUTIES
===================================================== */

async function getDutyForDate(
  date,
  env
) {
  const result =
    await env.DB.prepare(
      `SELECT
         d.*,
         s1.full_name AS student1_name,
         s2.full_name AS student2_name
       FROM duties d
       LEFT JOIN students s1
         ON s1.id = d.student1_id
       LEFT JOIN students s2
         ON s2.id = d.student2_id
       WHERE d.duty_date = ?`
    )
      .bind(date)
      .first();

  return result || null;
}


/* =====================================================
   DUTY QUEUE
===================================================== */

async function generateDutySchedule(
  env
) {
  const pairsResult =
    await env.DB.prepare(
      `SELECT
         pair_number,
         student1_id,
         student2_id
       FROM duty_pairs
       WHERE active = 1
       ORDER BY pair_number`
    )
      .all();

  const pairs =
    pairsResult.results || [];

  if (!pairs.length) {
    return;
  }

  let pairIndex = 0;

  const existingResult =
    await env.DB.prepare(
      `SELECT duty_date
       FROM duties
       ORDER BY duty_date DESC
       LIMIT 1`
    )
      .first();

  let date =
    existingResult?.duty_date ||
    DUTY_START_DATE;

  if (
    existingResult?.duty_date
  ) {
    date =
      addDays(date, 1);
  }

  for (
    let i = 0;
    i < DUTY_GENERATE_DAYS;
    i++
  ) {
    if (
      isWeekend(date)
    ) {
      date =
        addDays(date, 1);
      continue;
    }

    const calendar =
      await env.DB.prepare(
        `SELECT status
         FROM calendar
         WHERE calendar_date = ?`
      )
        .bind(date)
        .first();

    if (
      calendar &&
      calendar.status !== "school"
    ) {
      date =
        addDays(date, 1);
      continue;
    }

    const exists =
      await env.DB.prepare(
        `SELECT id
         FROM duties
         WHERE duty_date = ?`
      )
        .bind(date)
        .first();

    if (!exists) {
      const pair =
        pairs[pairIndex % pairs.length];

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
          date,
          pair.pair_number,
          pair.student1_id,
          pair.student2_id
        )
        .run();

      pairIndex++;
    }

    date =
      addDays(date, 1);
  }
}


/* =====================================================
   SHOW DUTY
===================================================== */

async function showDuty(
  chatId,
  telegramId,
  env
) {
  await generateDutySchedule(env);

  const date =
    getLocalDate();

  const duty =
    await getDutyForDate(
      date,
      env
    );

  let text =
    `🧹 <b>Дежурство</b>\n\n`;

  if (!duty) {
    text +=
      `Сегодня дежурство не назначено.`;
  } else {
    text +=
      `📅 ${formatDate(date)}\n\n` +
      `👥 <b>Сегодня дежурят:</b>\n` +
      `${duty.student1_name}\n` +
      `${duty.student2_name}`;

    if (
      duty.status ===
      "cancelled"
    ) {
      text +=
        `\n\n❌ Дежурство отменено`;

      if (
        duty.cancelled_reason
      ) {
        text +=
          `\nПричина: ${duty.cancelled_reason}`;
      }
    }
  }

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔄 Попросить замену",
              callback_data:
                "replacement"
            }
          ],
          [
            {
              text: "◀️ Назад",
              callback_data:
                "menu"
            }
          ]
        ]
      }
    },
    env
  );
}
/* =====================================================
   HOMEWORK
===================================================== */

async function showHomework(
  chatId,
  telegramId,
  env
) {
  const today =
    getLocalDate();

  const tomorrow =
    addDays(today, 1);

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "📖 Сегодня",
          callback_data:
            "hw_today"
        },
        {
          text: "📚 Завтра",
          callback_data:
            "hw_tomorrow"
        }
      ],
      [
        {
          text: "📅 На неделю",
          callback_data:
            "hw_week"
        }
      ],
      [
        {
          text: "📚 Все ДЗ",
          callback_data:
            "hw_all"
        }
      ],
      [
        {
          text: "◀️ Назад",
          callback_data:
            "menu"
        }
      ]
    ]
  };

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `📚 <b>Домашнее задание</b>\n\n` +
        `Выбери нужный период 👇`,
      parse_mode: "HTML",
      reply_markup: keyboard
    },
    env
  );
}


/* =====================================================
   HOMEWORK FOR PERIOD
===================================================== */

async function showHomeworkPeriod(
  chatId,
  period,
  env
) {
  const today =
    getLocalDate();

  let startDate =
    today;

  let endDate =
    today;

  if (period === "tomorrow") {
    startDate =
      addDays(today, 1);

    endDate =
      startDate;
  }

  if (period === "week") {
    endDate =
      addDays(today, 6);
  }

  if (period === "all") {
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
         ORDER BY lesson_date, lesson_number, id`
      )
        .all();

    const rows =
      result.results || [];

    let text =
      `📚 <b>Все домашние задания</b>\n\n`;

    if (!rows.length) {
      text +=
        `Пока домашних заданий нет.`;
    } else {
      let currentDate = "";

      for (
        const item
        of rows
      ) {
        if (
          item.lesson_date !==
          currentDate
        ) {
          currentDate =
            item.lesson_date;

          text +=
            `\n📅 <b>${formatDate(currentDate)}</b>\n`;
        }

        text +=
          `• <b>${item.subject}</b>`;

        if (
          item.lesson_number
        ) {
          text +=
            ` · урок ${item.lesson_number}`;
        }

        text +=
          `\n${item.text}\n`;
      }
    }

    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup:
          backMenu("homework")
      },
      env
    );

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
       WHERE lesson_date >= ?
         AND lesson_date <= ?
         AND is_archived = 0
       ORDER BY lesson_date, lesson_number, id`
    )
      .bind(
        startDate,
        endDate
      )
      .all();

  const rows =
    result.results || [];

  let title =
    "📚 Домашнее задание";

  if (period === "today") {
    title =
      `📖 ДЗ на сегодня`;
  }

  if (period === "tomorrow") {
    title =
      `📚 ДЗ на завтра`;
  }

  if (period === "week") {
    title =
      `📅 ДЗ на неделю`;
  }

  let text =
    `<b>${title}</b>\n\n`;

  if (!rows.length) {
    text +=
      `Домашних заданий нет 🎉`;
  } else {
    let currentDate = "";

    for (
      const item
      of rows
    ) {
      if (
        item.lesson_date !==
        currentDate
      ) {
        currentDate =
          item.lesson_date;

        text +=
          `📅 <b>${formatDate(currentDate)}</b>\n`;
      }

      text +=
        `• <b>${item.subject}</b>`;

      if (
        item.lesson_number
      ) {
        text +=
          ` · урок ${item.lesson_number}`;
      }

      text +=
        `\n${item.text}\n\n`;
    }
  }

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup:
        backMenu("homework")
    },
    env
  );
}


/* =====================================================
   REPLACEMENTS
===================================================== */

async function beginReplacement(
  chatId,
  telegramId,
  env
) {
  const student =
    await env.DB.prepare(
      `SELECT id, full_name
       FROM students
       WHERE telegram_id = ?
         AND is_active = 1`
    )
      .bind(telegramId)
      .first();

  if (!student) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⛔ Твой Telegram пока не привязан к участнику ПК-38.\n\n` +
          `Обратись к старосте или заместителю.`,
        reply_markup:
          backMenu("duty")
      },
      env
    );

    return;
  }

  const date =
    getLocalDate();

  const duty =
    await getDutyForDate(
      date,
      env
    );

  if (!duty) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `🧹 На сегодня дежурство не назначено.`,
        reply_markup:
          backMenu("duty")
      },
      env
    );

    return;
  }

  const isDutyStudent =
    Number(duty.student1_id) ===
      Number(student.id) ||
    Number(duty.student2_id) ===
      Number(student.id);

  if (!isDutyStudent) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `ℹ️ Сегодня ты не дежуришь, поэтому запрашивать замену не нужно.`,
        reply_markup:
          backMenu("duty")
      },
      env
    );

    return;
  }

  await setPendingInput(
    telegramId,
    {
      action:
        "replacement_reason",
      dutyDate:
        date,
      requesterId:
        student.id
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🔄 <b>Запрос на замену</b>\n\n` +
        `📅 Дата: ${formatDate(date)}\n\n` +
        `Напиши причину, почему тебе нужна замена.\n\n` +
        `Например: заболел, не смогу прийти, другая уважительная причина.\n\n` +
        `Для отмены: /cancel`,
      parse_mode: "HTML",
      reply_markup:
        backMenu("duty")
    },
    env
  );
}


/* =====================================================
   SELECT REPLACEMENT PERSON
===================================================== */

async function selectReplacementPerson(
  chatId,
  telegramId,
  env,
  dutyDate,
  requesterId,
  reason
) {
  const studentsResult =
    await env.DB.prepare(
      `SELECT
         id,
         full_name
       FROM students
       WHERE is_active = 1
         AND id != ?
       ORDER BY full_name`
    )
      .bind(requesterId)
      .all();

  const students =
    studentsResult.results || [];

  const keyboard = [];

  for (
    const student
    of students
  ) {
    keyboard.push([
      {
        text:
          student.full_name,
        callback_data:
          `replace_person_${dutyDate}_${requesterId}_${student.id}`
      }
    ]);
  }

  keyboard.push([
    {
      text: "◀️ Назад",
      callback_data:
        "duty"
    }
  ]);

  await setPendingInput(
    telegramId,
    {
      action:
        "replacement_person",
      dutyDate,
      requesterId,
      reason
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `👤 <b>Кого попросить о замене?</b>\n\n` +
        `Выбери одногруппника из списка:`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    },
    env
  );
}


/* =====================================================
   CREATE REPLACEMENT
===================================================== */

async function createReplacement(
  chatId,
  telegramId,
  dutyDate,
  requesterId,
  replacementId,
  reason,
  env
) {
  const requester =
    await env.DB.prepare(
      `SELECT full_name
       FROM students
       WHERE id = ?`
    )
      .bind(requesterId)
      .first();

  const replacement =
    await env.DB.prepare(
      `SELECT
         id,
         full_name,
         telegram_id
       FROM students
       WHERE id = ?`
    )
      .bind(replacementId)
      .first();

  if (
    !requester ||
    !replacement
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `❌ Не удалось создать запрос.`,
        reply_markup:
          backMenu("duty")
      },
      env
    );

    return;
  }

  const existing =
    await env.DB.prepare(
      `SELECT id
       FROM replacements
       WHERE duty_date = ?
         AND requester_id = ?
         AND status IN ('pending', 'accepted')
       LIMIT 1`
    )
      .bind(
        dutyDate,
        requesterId
      )
      .first();

  if (existing) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⚠️ У тебя уже есть активный запрос на замену на эту дату.`,
        reply_markup:
          backMenu("duty")
      },
      env
    );

    return;
  }

  const result =
    await env.DB.prepare(
      `INSERT INTO replacements
       (
         duty_date,
         requester_id,
         replacement_id,
         reason,
         status,
         created_at
       )
       VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`
    )
      .bind(
        dutyDate,
        requesterId,
        replacementId,
        reason
      )
      .run();

  const replacementIdDb =
    result.meta?.last_row_id;

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `📨 <b>Запрос отправлен</b>\n\n` +
        `📅 ${formatDate(dutyDate)}\n` +
        `👤 Кто просит: ${requester.full_name}\n` +
        `🔄 На замену: ${replacement.full_name}\n` +
        `📝 Причина: ${reason}\n\n` +
        `Сначала запрос должен принять человек, которого ты выбрал, а затем его утвердит староста или заместитель.`,
      parse_mode: "HTML",
      reply_markup:
        backMenu("duty")
    },
    env
  );

  /*
     Отправляем уведомление выбранному человеку,
     только если Telegram привязан.
  */
  if (
    replacement.telegram_id
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id:
          replacement.telegram_id,
        text:
          `🔄 <b>Тебе предложили замену</b>\n\n` +
          `📅 Дата: ${formatDate(dutyDate)}\n` +
          `👤 ${requester.full_name} просит тебя заменить его на дежурстве.\n\n` +
          `📝 Причина: ${reason}`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Принять",
                callback_data:
                  `replacement_accept_${replacementIdDb}`
              },
              {
                text: "❌ Отклонить",
                callback_data:
                  `replacement_reject_${replacementIdDb}`
              }
            ]
          ]
        }
      },
      env
    );
  }

  /*
     Уведомляем старосту и заместителя.
  */
  await notifyAdmins(
    `🔄 <b>Новый запрос на замену</b>\n\n` +
    `📅 ${formatDate(dutyDate)}\n` +
    `👤 ${requester.full_name}\n` +
    `➡️ ${replacement.full_name}\n` +
    `📝 ${reason}`,
    env
  );

  await clearPendingInput(
    telegramId,
    env
  );
}


/* =====================================================
   LATENESS
===================================================== */

async function beginLateness(
  chatId,
  telegramId,
  env
) {
  const student =
    await env.DB.prepare(
      `SELECT id, full_name
       FROM students
       WHERE telegram_id = ?
         AND is_active = 1`
    )
      .bind(telegramId)
      .first();

  if (!student) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⛔ Твой Telegram пока не привязан к участнику ПК-38.`,
        reply_markup:
          backMenu("menu")
      },
      env
    );

    return;
  }

  await setPendingInput(
    telegramId,
    {
      action:
        "lateness_time",
      studentId:
        student.id
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `⏰ <b>Я опоздаю</b>\n\n` +
        `Напиши, во сколько примерно придёшь.\n\n` +
        `Например: <b>09:45</b>\n\n` +
        `Для отмены: /cancel`,
      parse_mode: "HTML",
      reply_markup:
        backMenu("menu")
    },
    env
  );
}


/* =====================================================
   SAVE LATENESS
===================================================== */

async function saveLateness(
  chatId,
  telegramId,
  expectedTime,
  env
) {
  if (
    !/^\d{2}:\d{2}$/.test(
      expectedTime
    )
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⚠️ Введи время в формате ЧЧ:ММ.\n\nНапример: 09:45`,
        reply_markup:
          backMenu("menu")
      },
      env
    );

    return;
  }

  const [
    hour,
    minute
  ] =
    expectedTime
      .split(":")
      .map(Number);

  if (
    hour > 23 ||
    minute > 59
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⚠️ Такого времени нет.\n\nПопробуй ещё раз, например 09:45.`,
        reply_markup:
          backMenu("menu")
      },
      env
    );

    return;
  }

  const student =
    await env.DB.prepare(
      `SELECT
         id,
         full_name
       FROM students
       WHERE telegram_id = ?
         AND is_active = 1`
    )
      .bind(telegramId)
      .first();

  if (!student) {
    return;
  }

  const date =
    getLocalDate();

  await env.DB.prepare(
    `INSERT INTO lateness
     (
       student_id,
       lesson_date,
       expected_time
     )
     VALUES (?, ?, ?)`
  )
    .bind(
      student.id,
      date,
      expectedTime
    )
    .run();

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `⏰ <b>Готово</b>\n\n` +
        `Я сообщил старосте и заместителю, что ${student.full_name} опоздает.\n\n` +
        `🕐 Ожидаемое время: ${expectedTime}`,
      parse_mode: "HTML",
      reply_markup:
        backMenu("menu")
    },
    env
  );

  await notifyAdmins(
    `⏰ <b>Опоздание</b>\n\n` +
    `👤 ${student.full_name}\n` +
    `📅 ${formatDate(date)}\n` +
    `🕐 Ожидаемое время: ${expectedTime}`,
    env
  );

  await clearPendingInput(
    telegramId,
    env
  );
}


/* =====================================================
   NOTIFY ADMINS
===================================================== */

async function notifyAdmins(
  text,
  env
) {
  const result =
    await env.DB.prepare(
      `SELECT telegram_id
       FROM students
       WHERE role IN ('admin', 'deputy')
         AND is_active = 1
         AND telegram_id IS NOT NULL`
    )
      .all();

  for (
    const admin
    of result.results || []
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id:
          admin.telegram_id,
        text,
        parse_mode: "HTML"
      },
      env
    );
  }
}


/* =====================================================
   PENDING INPUT
===================================================== */

async function setPendingInput(
  telegramId,
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
      JSON.stringify(data)
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

  if (!result?.value) {
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


/* =====================================================
   ANSWER CALLBACK
===================================================== */

async function answerCallback(
  callbackId,
  env
) {
  if (!callbackId) {
    return;
  }

  try {
    await telegram(
      "answerCallbackQuery",
      {
        callback_query_id:
          callbackId
      },
      env
    );
  } catch {
    /*
       Telegram может вернуть ошибку,
       если callback уже обработан.
    */
  }
}
/* =====================================================
   CALLBACK HANDLER
===================================================== */

async function handleCallback(
  query,
  env
) {
  const callbackId =
    query.id;

  const data =
    query.data || "";

  const message =
    query.message;

  if (!message) {
    await answerCallback(
      callbackId,
      env
    );
    return;
  }

  const chatId =
    message.chat.id;

  const telegramId =
    query.from.id;

  await answerCallback(
    callbackId,
    env
  );

  /*
     Удаляем старое меню.
     Благодаря этому бот не создаёт
     десятки сообщений при навигации.
  */
  try {
    await telegram(
      "deleteMessage",
      {
        chat_id: chatId,
        message_id:
          message.message_id
      },
      env
    );
  } catch {
    // Сообщение уже могло быть удалено.
  }


  /* ===================================================
     ГЛАВНОЕ МЕНЮ
  =================================================== */

  if (
    data === "menu" ||
    data === "back_menu"
  ) {
    await showMainMenu(
      chatId,
      telegramId,
      env
    );
    return;
  }


  /* ===================================================
     СЕГОДНЯ
  =================================================== */

  if (
    data === "today"
  ) {
    await showToday(
      chatId,
      telegramId,
      env
    );
    return;
  }


  /* ===================================================
     РАСПИСАНИЕ
  =================================================== */

  if (
    data === "schedule"
  ) {
    await showSchedule(
      chatId,
      telegramId,
      env
    );
    return;
  }

  if (
    data.startsWith(
      "schedule_day_"
    )
  ) {
    const day =
      Number(
        data.replace(
          "schedule_day_",
          ""
        )
      );

    await showScheduleDay(
      chatId,
      telegramId,
      day,
      env
    );
    return;
  }

  if (
    data ===
    "current_lesson"
  ) {
    await showCurrentLesson(
      chatId,
      telegramId,
      env
    );
    return;
  }


  /* ===================================================
     ДОМАШНЕЕ ЗАДАНИЕ
  =================================================== */

  if (
    data === "homework"
  ) {
    await showHomework(
      chatId,
      telegramId,
      env
    );
    return;
  }

  if (
    data === "hw_today"
  ) {
    await showHomeworkPeriod(
      chatId,
      "today",
      env
    );
    return;
  }

  if (
    data === "hw_tomorrow"
  ) {
    await showHomeworkPeriod(
      chatId,
      "tomorrow",
      env
    );
    return;
  }

  if (
    data === "hw_week"
  ) {
    await showHomeworkPeriod(
      chatId,
      "week",
      env
    );
    return;
  }

  if (
    data === "hw_all"
  ) {
    await showHomeworkPeriod(
      chatId,
      "all",
      env
    );
    return;
  }


  /* ===================================================
     ДЕЖУРСТВО
  =================================================== */

  if (
    data === "duty"
  ) {
    await showDuty(
      chatId,
      telegramId,
      env
    );
    return;
  }

  if (
    data === "duty_replace"
  ) {
    await beginReplacement(
      chatId,
      telegramId,
      env
    );
    return;
  }


  /* ===================================================
     ВЫБОР ЧЕЛОВЕКА ДЛЯ ЗАМЕНЫ
  =================================================== */

  if (
    data.startsWith(
      "replace_person_"
    )
  ) {
    const parts =
      data.split("_");

    /*
      replace_person_DATE_REQUESTER_REPLACEMENT

      Так как дата содержит дефисы,
      split по "_" безопасен.
    */

    const dutyDate =
      parts[2];

    const requesterId =
      Number(parts[3]);

    const replacementId =
      Number(parts[4]);

    const pending =
      await getPendingInput(
        telegramId,
        env
      );

    const reason =
      pending?.reason ||
      "Причина не указана";

    await createReplacement(
      chatId,
      telegramId,
      dutyDate,
      requesterId,
      replacementId,
      reason,
      env
    );

    return;
  }


  /* ===================================================
     ПРИНЯТИЕ / ОТКЛОНЕНИЕ ЗАМЕНЫ
  =================================================== */

  if (
    data.startsWith(
      "replacement_accept_"
    )
  ) {
    const replacementId =
      Number(
        data.replace(
          "replacement_accept_",
          ""
        )
      );

    await handleReplacementResponse(
      chatId,
      telegramId,
      replacementId,
      "accepted",
      env
    );

    return;
  }

  if (
    data.startsWith(
      "replacement_reject_"
    )
  ) {
    const replacementId =
      Number(
        data.replace(
          "replacement_reject_",
          ""
        )
      );

    await handleReplacementResponse(
      chatId,
      telegramId,
      replacementId,
      "rejected",
      env
    );

    return;
  }


  /* ===================================================
     ОПОЗДАНИЕ
  =================================================== */

  if (
    data === "lateness"
  ) {
    await beginLateness(
      chatId,
      telegramId,
      env
    );
    return;
  }


  /* ===================================================
     МОЯ СТАТИСТИКА
  =================================================== */

  if (
    data === "my_stats"
  ) {
    await showMyStats(
      chatId,
      telegramId,
      env
    );
    return;
  }


  /* ===================================================
     ОБЪЯВЛЕНИЯ
  =================================================== */

  if (
    data === "announcements"
  ) {
    await showPublishedAnnouncements(
      chatId,
      telegramId,
      env
    );
    return;
  }


  /* ===================================================
     НАЗАД
  =================================================== */

  if (
    data === "back"
  ) {
    await showMainMenu(
      chatId,
      telegramId,
      env
    );
    return;
  }


  /* ===================================================
     АДМИН-ПАНЕЛЬ
  =================================================== */

  if (
    data === "admin"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminPanel(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — ДЕЖУРСТВА
  =================================================== */

  if (
    data === "admin_duties"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminDuties(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — УЧАСТНИКИ
  =================================================== */

  if (
    data === "admin_students"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminStudents(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — КАЛЕНДАРЬ
  =================================================== */

  if (
    data === "admin_calendar"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminCalendar(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — РАСПИСАНИЕ
  =================================================== */

  if (
    data === "admin_schedule"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminSchedule(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — ДЗ
  =================================================== */

  if (
    data === "admin_homework"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminHomework(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — ОБЪЯВЛЕНИЯ
  =================================================== */

  if (
    data === "admin_announcements"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminAnnouncements(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — ОПОВЕЩЕНИЯ
  =================================================== */

  if (
    data === "admin_alerts"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminAlerts(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — ПОСЕЩАЕМОСТЬ
  =================================================== */

  if (
    data === "admin_attendance"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminAttendance(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — ЗАМЕНЫ
  =================================================== */

  if (
    data === "admin_replacements"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminReplacements(
      chatId,
      telegramId,
      null,
      env
    );

    return;
  }

  if (
    data ===
    "admin_replacements_pending"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminReplacements(
      chatId,
      telegramId,
      "pending",
      env
    );

    return;
  }

  if (
    data ===
    "admin_replacements_accepted"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminReplacements(
      chatId,
      telegramId,
      "accepted",
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — СТАТИСТИКА
  =================================================== */

  if (
    data === "admin_stats"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminStats(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — УЧЕБНЫЙ ГОД
  =================================================== */

  if (
    data === "admin_academic_year"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAcademicYear(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — НАСТРОЙКИ
  =================================================== */

  if (
    data === "admin_settings"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await showAdminSettings(
      chatId,
      telegramId,
      env
    );

    return;
  }


  /* ===================================================
     АДМИН — РЕЗЕРВНАЯ КОПИЯ
  =================================================== */

  if (
    data === "admin_backup"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      return;
    }

    await sendDatabaseBackup(
      chatId,
      env
    );

    return;
  }


  /* ===================================================
     ЕСЛИ КНОПКА НЕ НАЙДЕНА
  =================================================== */

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `⚠️ Неизвестное действие.\n\n` +
        `Вернись в главное меню.`,
      reply_markup:
        backMenu("menu")
    },
    env
  );
}


/* =====================================================
   REPLACEMENT RESPONSE
===================================================== */

async function handleReplacementResponse(
  chatId,
  telegramId,
  replacementId,
  status,
  env
) {
  const student =
    await env.DB.prepare(
      `SELECT
         id,
         full_name
       FROM students
       WHERE telegram_id = ?
         AND is_active = 1`
    )
      .bind(telegramId)
      .first();

  if (!student) {
    return;
  }

  const replacement =
    await env.DB.prepare(
      `SELECT
         r.id,
         r.duty_date,
         r.requester_id,
         r.replacement_id,
         r.reason,
         r.status,
         s.full_name AS requester_name
       FROM replacements r
       JOIN students s
         ON s.id = r.requester_id
       WHERE r.id = ?`
    )
      .bind(replacementId)
      .first();

  if (!replacement) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `❌ Запрос на замену не найден.`
      },
      env
    );

    return;
  }

  /*
     Только выбранный человек может
     принять или отклонить замену.
  */
  if (
    Number(
      replacement.replacement_id
    ) !== Number(student.id)
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⛔ Ты не можешь изменить этот запрос.`
      },
      env
    );

    return;
  }

  if (
    replacement.status !==
    "pending"
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `ℹ️ Этот запрос уже обработан.`
      },
      env
    );

    return;
  }

  await env.DB.prepare(
    `UPDATE replacements
     SET status = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(
      status,
      replacementId
    )
    .run();

  const statusText =
    status === "accepted"
      ? "принята"
      : "отклонена";

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        status === "accepted"
          ? `✅ Ты принял замену на ${formatDate(replacement.duty_date)}.`
          : `❌ Ты отклонил замену на ${formatDate(replacement.duty_date)}.`,
      reply_markup:
        backMenu("menu")
    },
    env
  );

  /*
     Сообщаем человеку, который запросил замену.
  */
  const requester =
    await env.DB.prepare(
      `SELECT
         telegram_id,
         full_name
       FROM students
       WHERE id = ?`
    )
      .bind(
        replacement.requester_id
      )
      .first();

  if (
    requester?.telegram_id
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id:
          requester.telegram_id,
        text:
          status === "accepted"
            ? `✅ <b>${student.full_name}</b> принял твою просьбу о замене.\n\n` +
              `📅 ${formatDate(replacement.duty_date)}\n\n` +
              `Теперь запрос должен утвердить староста или заместитель.`
            : `❌ <b>${student.full_name}</b> отклонил твою просьбу о замене.\n\n` +
              `📅 ${formatDate(replacement.duty_date)}`,
        parse_mode: "HTML"
      },
      env
    );
  }

  /*
     Если человек принял замену —
     уведомляем администрацию.
  */
  if (
    status === "accepted"
  ) {
    await notifyAdmins(
      `🔄 <b>Замена принята</b>\n\n` +
      `📅 ${formatDate(replacement.duty_date)}\n` +
      `👤 ${replacement.requester_name}\n` +
      `🔁 ${student.full_name}\n\n` +
      `Ожидает утверждения старосты или заместителя.`,
      env
    );
  }
}


/* =====================================================
   SAFE BACK BUTTON
===================================================== */

function backMenu(
  target = "menu"
) {
  return {
    inline_keyboard: [
      [
        {
          text: "◀️ Назад",
          callback_data:
            target
        }
      ]
    ]
  };
}
/* =====================================================
   TEXT INPUT HANDLER
===================================================== */

async function handlePendingInput(
  message,
  env
) {
  const chatId =
    message.chat.id;

  const telegramId =
    message.from.id;

  const text =
    (message.text || "").trim();

  if (!text) {
    return;
  }

  /*
     Отмена любого текущего действия
  */
  if (
    text === "/cancel" ||
    text === "❌ Отмена"
  ) {
    await clearPendingInput(
      telegramId,
      env
    );

    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `❌ Действие отменено.`,
        reply_markup:
          backMenu("menu")
      },
      env
    );

    return;
  }

  const pending =
    await getPendingInput(
      telegramId,
      env
    );

  if (!pending) {
    return;
  }


  /* ===================================================
     ПРИЧИНА ЗАМЕНЫ
  =================================================== */

  if (
    pending.action ===
    "replacement_reason"
  ) {
    if (text.length < 3) {
      await telegram(
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `⚠️ Напиши причину чуть подробнее.`,
          reply_markup:
            backMenu("duty")
        },
        env
      );

      return;
    }

    await clearPendingInput(
      telegramId,
      env
    );

    await selectReplacementPerson(
      chatId,
      telegramId,
      env,
      pending.dutyDate,
      pending.requesterId,
      text
    );

    return;
  }


  /* ===================================================
     ВРЕМЯ ОПОЗДАНИЯ
  =================================================== */

  if (
    pending.action ===
    "lateness_time"
  ) {
    await saveLateness(
      chatId,
      telegramId,
      text,
      env
    );

    return;
  }


  /* ===================================================
     ДОБАВЛЕНИЕ ДЗ
  =================================================== */

  if (
    pending.action ===
    "homework_text"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      await clearPendingInput(
        telegramId,
        env
      );

      return;
    }

    await env.DB.prepare(
      `INSERT INTO homework
       (
         lesson_date,
         subject,
         text,
         lesson_number,
         added_by,
         is_archived
       )
       VALUES (?, ?, ?, ?, ?, 0)`
    )
      .bind(
        pending.lessonDate,
        pending.subject,
        text,
        pending.lessonNumber ||
          null,
        telegramId
      )
      .run();

    await clearPendingInput(
      telegramId,
      env
    );

    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `✅ <b>Домашнее задание добавлено</b>\n\n` +
          `📅 ${formatDate(pending.lessonDate)}\n` +
          `📚 ${pending.subject}\n\n` +
          `${text}`,
        parse_mode: "HTML",
        reply_markup:
          backMenu(
            "admin_homework"
          )
      },
      env
    );

    return;
  }


  /* ===================================================
     СОЗДАНИЕ ОБЪЯВЛЕНИЯ
  =================================================== */

  if (
    pending.action ===
    "announcement_text"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      await clearPendingInput(
        telegramId,
        env
      );

      return;
    }

    await clearPendingInput(
      telegramId,
      env
    );

    await showAnnouncementPreview(
      chatId,
      telegramId,
      text,
      env
    );

    return;
  }


  /* ===================================================
     ДАТА ПОСЕЩАЕМОСТИ
  =================================================== */

  if (
    pending.action ===
    "attendance_date"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      await clearPendingInput(
        telegramId,
        env
      );

      return;
    }

    if (
      !/^\d{2}\.\d{2}\.\d{4}$/.test(
        text
      )
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `⚠️ Введи дату в формате ДД.ММ.ГГГГ.\n\n` +
            `Например: 08.09.2026`,
          reply_markup:
            backMenu(
              "admin_attendance"
            )
        },
        env
      );

      return;
    }

    const [
      day,
      month,
      year
    ] =
      text
        .split(".")
        .map(Number);

    const date =
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    await clearPendingInput(
      telegramId,
      env
    );

    await showAttendanceForDate(
      chatId,
      telegramId,
      date,
      env
    );

    return;
  }


  /* ===================================================
     КАЛЕНДАРЬ
  =================================================== */

  if (
    pending.action ===
    "calendar_add"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      await clearPendingInput(
        telegramId,
        env
      );

      return;
    }

    const parts =
      text.split("|");

    if (
      parts.length < 2
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `⚠️ Формат:\n\n` +
            `ДД.ММ.ГГГГ | причина\n\n` +
            `Например:\n` +
            `01.10.2026 | Праздник`,
          reply_markup:
            backMenu(
              "admin_calendar"
            )
        },
        env
      );

      return;
    }

    const dateText =
      parts[0].trim();

    const reason =
      parts
        .slice(1)
        .join("|")
        .trim();

    if (
      !/^\d{2}\.\d{2}\.\d{4}$/.test(
        dateText
      )
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `⚠️ Неверная дата.\n\n` +
            `Используй ДД.ММ.ГГГГ.`,
          reply_markup:
            backMenu(
              "admin_calendar"
            )
        },
        env
      );

      return;
    }

    const [
      day,
      month,
      year
    ] =
      dateText
        .split(".")
        .map(Number);

    const date =
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    const status =
      pending.calendarStatus ||
      "day_off";

    await env.DB.prepare(
      `INSERT INTO calendar
       (
         calendar_date,
         status,
         reason,
         created_by
       )
       VALUES (?, ?, ?, ?)
       ON CONFLICT(calendar_date)
       DO UPDATE SET
         status = excluded.status,
         reason = excluded.reason,
         created_by = excluded.created_by`
    )
      .bind(
        date,
        status,
        reason || null,
        telegramId
      )
      .run();

    await clearPendingInput(
      telegramId,
      env
    );

    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `✅ <b>Дата добавлена в календарь</b>\n\n` +
          `📅 ${formatDate(date)}\n` +
          `📌 ${status}\n` +
          `📝 ${reason || "Без причины"}`,
        parse_mode: "HTML",
        reply_markup:
          backMenu(
            "admin_calendar"
          )
      },
      env
    );

    return;
  }


  /* ===================================================
     НОВЫЙ УЧЕБНЫЙ ГОД
  =================================================== */

  if (
    pending.action ===
    "academic_new_year"
  ) {
    if (
      !await isAdmin(
        telegramId,
        env
      )
    ) {
      await clearPendingInput(
        telegramId,
        env
      );

      return;
    }

    if (
      !/^\d{4}-\d{4}$/.test(
        text
      )
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `⚠️ Используй формат:\n\n` +
            `2027-2028`,
          reply_markup:
            backMenu(
              "admin_academic_year"
            )
        },
        env
      );

      return;
    }

    const [
      startYear,
      endYear
    ] =
      text
        .split("-")
        .map(Number);

    if (
      endYear !==
      startYear + 1
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `⚠️ Учебный год должен состоять из двух последовательных лет.\n\n` +
            `Например: 2027-2028`,
          reply_markup:
            backMenu(
              "admin_academic_year"
            )
        },
        env
      );

      return;
    }

    await env.DB.prepare(
      `UPDATE academic_years
       SET is_current = 0`
    )
      .run();

    await env.DB.prepare(
      `INSERT INTO academic_years
       (
         name,
         is_current
       )
       VALUES (?, 1)
       ON CONFLICT(name)
       DO UPDATE SET
         is_current = 1`
    )
      .bind(text)
      .run();

    await clearPendingInput(
      telegramId,
      env
    );

    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `🎓 <b>Учебный год изменён</b>\n\n` +
          `Теперь текущий учебный год: <b>${text}</b>`,
        parse_mode: "HTML",
        reply_markup:
          backMenu(
            "admin_academic_year"
          )
      },
      env
    );

    return;
  }


  /* ===================================================
     НЕИЗВЕСТНЫЙ ВВОД
  =================================================== */

  await clearPendingInput(
    telegramId,
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `⚠️ Это действие больше не активно.\n\n` +
        `Вернись в меню и попробуй ещё раз.`,
      reply_markup:
        backMenu("menu")
    },
    env
  );
}


/* =====================================================
   MAIN MESSAGE ROUTER
===================================================== */

async function routeMessage(
  message,
  env
) {
  if (!message) {
    return;
  }

  if (
    message.text &&
    message.text.startsWith("/")
  ) {
    await handleCommand(
      message,
      env
    );

    return;
  }

  const pending =
    await getPendingInput(
      message.from.id,
      env
    );

  if (pending) {
    await handlePendingInput(
      message,
      env
    );

    return;
  }

  /*
     Если человек написал обычный текст
     без активного действия — ничего
     не публикуем в группе.
  */
}


/* =====================================================
   COMMANDS
===================================================== */

async function handleCommand(
  message,
  env
) {
  const chatId =
    message.chat.id;

  const telegramId =
    message.from.id;

  const command =
    (
      message.text || ""
    )
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();


  /* ===================================================
     /start
  =================================================== */

  if (
    command === "/start"
  ) {
    await startCommand(
      message,
      env
    );

    return;
  }


  /* ===================================================
     /cancel
  =================================================== */

  if (
    command === "/cancel"
  ) {
    await clearPendingInput(
      telegramId,
      env
    );

    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `❌ Текущее действие отменено.`,
        reply_markup:
          backMenu("menu")
      },
      env
    );

    return;
  }


  /* ===================================================
     /id
  =================================================== */

  if (
    command === "/id"
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `🆔 Твой Telegram ID:\n\n` +
          `<code>${telegramId}</code>`,
        parse_mode: "HTML"
      },
      env
    );

    return;
  }


  /* ===================================================
     НЕИЗВЕСТНАЯ КОМАНДА
  =================================================== */

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🤔 Не знаю такой команды.\n\n` +
        `Используй /start, чтобы открыть меню.`
    },
    env
  );
}
/* =====================================================
   ADMIN PANEL
===================================================== */

async function showAdminPanel(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "🧹 Дежурства",
          callback_data:
            "admin_duties"
        },
        {
          text: "📅 Календарь",
          callback_data:
            "admin_calendar"
        }
      ],
      [
        {
          text: "📚 Расписание",
          callback_data:
            "admin_schedule"
        },
        {
          text: "📚 ДЗ",
          callback_data:
            "admin_homework"
        }
      ],
      [
        {
          text: "📢 Объявления",
          callback_data:
            "admin_announcements"
        },
        {
          text: "📢 Оповещения",
          callback_data:
            "admin_alerts"
        }
      ],
      [
        {
          text: "🕐 Посещаемость",
          callback_data:
            "admin_attendance"
        },
        {
          text: "🔄 Замены",
          callback_data:
            "admin_replacements"
        }
      ],
      [
        {
          text: "📊 Статистика",
          callback_data:
            "admin_stats"
        },
        {
          text: "👥 Участники",
          callback_data:
            "admin_students"
        }
      ],
      [
        {
          text: "🎓 Учебный год",
          callback_data:
            "admin_academic_year"
        },
        {
          text: "⚙️ Настройки",
          callback_data:
            "admin_settings"
        }
      ],
      [
        {
          text: "💾 Резервная копия",
          callback_data:
            "admin_backup"
        }
      ],
      [
        {
          text: "◀️ Главное меню",
          callback_data:
            "menu"
        }
      ]
    ]
  };

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `👑 <b>Админ-панель ПК-38</b>\n\n` +
        `Здесь доступны управление группой, расписанием, дежурствами и статистикой.\n\n` +
        `Выбери нужный раздел 👇`,
      parse_mode: "HTML",
      reply_markup: keyboard
    },
    env
  );
}


/* =====================================================
   ADMIN — STUDENTS
===================================================== */

async function showAdminStudents(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const result =
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
       ORDER BY full_name`
    )
      .all();

  const students =
    result.results || [];

  const keyboard = [];

  for (
    const student
    of students
  ) {
    keyboard.push([
      {
        text:
          `${student.role === "admin"
            ? "👑 "
            : student.role === "deputy"
              ? "⭐ "
              : "👤 "
          }${student.full_name}`,
        callback_data:
          `admin_student_${student.id}`
      }
    ]);
  }

  keyboard.push([
    {
      text: "◀️ Назад",
      callback_data:
        "admin"
    }
  ]);

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `👥 <b>Участники ПК-38</b>\n\n` +
        `Всего: <b>${students.length}</b>\n\n` +
        `Выбери человека для просмотра информации:`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    },
    env
  );
}


/* =====================================================
   ADMIN — STUDENT CARD
===================================================== */

async function showAdminStudentCard(
  chatId,
  telegramId,
  studentId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
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
         birthday,
         is_active
       FROM students
       WHERE id = ?`
    )
      .bind(studentId)
      .first();

  if (!student) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `❌ Участник не найден.`,
        reply_markup:
          backMenu(
            "admin_students"
          )
      },
      env
    );

    return;
  }

  let text =
    `👤 <b>${student.full_name}</b>\n\n`;

  text +=
    `📞 Телефон: ${student.phone || "не указан"}\n`;

  text +=
    `🆔 Telegram ID: ${
      student.telegram_id
        ? `<code>${student.telegram_id}</code>`
        : "не привязан"
    }\n`;

  text +=
    `👤 Username: ${
      student.username
        ? "@" +
          student.username.replace(
            /^@/,
            ""
          )
        : "нет"
    }\n`;

  text +=
    `🎂 День рождения: ${
      student.birthday || "не указан"
    }\n`;

  text +=
    `🔐 Роль: ${
      student.role === "admin"
        ? "Староста"
        : student.role === "deputy"
          ? "Заместитель"
          : "Участник"
    }\n`;

  text +=
    `📌 Статус: ${
      Number(student.is_active)
        ? "активен"
        : "неактивен"
    }`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "🔗 Привязать Telegram",
          callback_data:
            `link_student_${student.id}`
        }
      ],
      [
        {
          text: "🔓 Отвязать Telegram",
          callback_data:
            `unlink_student_${student.id}`
        }
      ],
      [
        {
          text: "◀️ Назад",
          callback_data:
            "admin_students"
        }
      ]
    ]
  };

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard
    },
    env
  );
}


/* =====================================================
   CREATE LINK CODE
===================================================== */

async function createLinkCode(
  chatId,
  telegramId,
  studentId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
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

  const code =
    Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();

  const expires =
    new Date(
      Date.now() +
      LINK_CODE_TTL_MINUTES *
        60 *
        1000
    ).toISOString();

  await env.DB.prepare(
    `DELETE FROM link_codes
     WHERE student_id = ?`
  )
    .bind(studentId)
    .run();

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
      expires,
      telegramId
    )
    .run();

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🔗 <b>Привязка Telegram</b>\n\n` +
        `👤 ${student.full_name}\n\n` +
        `Передай человеку этот код:\n\n` +
        `<code>${code}</code>\n\n` +
        `Он должен открыть бота и отправить этот код сообщением.\n\n` +
        `⏳ Код действует ${LINK_CODE_TTL_MINUTES} минут.`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          `admin_student_${studentId}`
        )
    },
    env
  );
}


/* =====================================================
   USE LINK CODE
===================================================== */

async function useLinkCode(
  chatId,
  telegramId,
  code,
  env
) {
  const normalized =
    code
      .trim()
      .toUpperCase();

  const link =
    await env.DB.prepare(
      `SELECT
         code,
         student_id,
         expires_at,
         used_at
       FROM link_codes
       WHERE code = ?`
    )
      .bind(normalized)
      .first();

  if (!link) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `❌ Код не найден.\n\n` +
          `Проверь код и попробуй ещё раз.`
      },
      env
    );

    return;
  }

  if (link.used_at) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `❌ Этот код уже использован.`
      },
      env
    );

    return;
  }

  if (
    new Date(
      link.expires_at
    ).getTime() <
    Date.now()
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⏳ Код уже истёк.\n\n` +
          `Попроси старосту создать новый код.`
      },
      env
    );

    return;
  }

  const alreadyLinked =
    await env.DB.prepare(
      `SELECT
         id,
         full_name
       FROM students
       WHERE telegram_id = ?
         AND id != ?`
    )
      .bind(
        telegramId,
        link.student_id
      )
      .first();

  if (alreadyLinked) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⚠️ Этот Telegram уже привязан к другому участнику ПК-38.\n\n` +
          `Если это ошибка — обратись к старосте.`
      },
      env
    );

    return;
  }

  await env.DB.prepare(
    `UPDATE students
     SET telegram_id = ?
     WHERE id = ?`
  )
    .bind(
      telegramId,
      link.student_id
    )
    .run();

  await env.DB.prepare(
    `UPDATE link_codes
     SET used_at = CURRENT_TIMESTAMP
     WHERE code = ?`
  )
    .bind(normalized)
    .run();

  const student =
    await env.DB.prepare(
      `SELECT full_name
       FROM students
       WHERE id = ?`
    )
      .bind(link.student_id)
      .first();

  await clearPendingInput(
    telegramId,
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `✅ <b>Telegram успешно привязан!</b>\n\n` +
        `👤 ${student?.full_name || "Участник ПК-38"}\n\n` +
        `Теперь бот сможет отправлять тебе личные уведомления.`,
      parse_mode: "HTML",
      reply_markup:
        backMenu("menu")
    },
    env
  );

  await notifyAdmins(
    `🔗 <b>Telegram привязан</b>\n\n` +
    `👤 ${student?.full_name || "Участник ПК-38"}\n` +
    `🆔 <code>${telegramId}</code>`,
    env
  );
}


/* =====================================================
   UNLINK TELEGRAM
===================================================== */

async function unlinkStudent(
  chatId,
  telegramId,
  studentId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
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

  await env.DB.prepare(
    `UPDATE students
     SET telegram_id = NULL
     WHERE id = ?`
  )
    .bind(studentId)
    .run();

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🔓 <b>Telegram отвязан</b>\n\n` +
        `👤 ${student.full_name}`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          `admin_student_${studentId}`
        )
    },
    env
  );
}


/* =====================================================
   ADMIN — CALENDAR
===================================================== */

async function showAdminCalendar(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         calendar_date,
         status,
         reason
       FROM calendar
       WHERE calendar_date >= ?
       ORDER BY calendar_date
       LIMIT 60`
    )
      .bind(
        getLocalDate()
      )
      .all();

  const rows =
    result.results || [];

  let text =
    `📅 <b>Календарь</b>\n\n`;

  if (!rows.length) {
    text +=
      `Особых дат пока нет.\n`;
  } else {
    for (
      const row
      of rows
    ) {
      text +=
        `📅 <b>${formatDate(row.calendar_date)}</b>\n`;

      text +=
        `📌 ${row.status}\n`;

      if (row.reason) {
        text +=
          `📝 ${row.reason}\n`;
      }

      text += `\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "➕ Добавить дату",
          callback_data:
            "calendar_add"
        }
      ],
      [
        {
          text: "🗑 Удалить дату",
          callback_data:
            "calendar_delete"
        }
      ],
      [
        {
          text: "◀️ Назад",
          callback_data:
            "admin"
        }
      ]
    ]
  };

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard
    },
    env
  );
}
/* =====================================================
   CALENDAR — ADD / DELETE
===================================================== */

async function beginCalendarAdd(
  chatId,
  telegramId,
  status,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  await setPendingInput(
    telegramId,
    {
      action: "calendar_add",
      calendarStatus:
        status || "day_off"
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `📅 <b>Добавление даты</b>\n\n` +
        `Отправь:\n\n` +
        `<code>ДД.ММ.ГГГГ | причина</code>\n\n` +
        `Например:\n` +
        `<code>01.10.2026 | Праздник</code>\n\n` +
        `Для отмены: /cancel`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          "admin_calendar"
        )
    },
    env
  );
}


async function showCalendarDelete(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         id,
         calendar_date,
         status,
         reason
       FROM calendar
       WHERE calendar_date >= ?
       ORDER BY calendar_date
       LIMIT 60`
    )
      .bind(
        getLocalDate()
      )
      .all();

  const rows =
    result.results || [];

  const keyboard = [];

  for (
    const row
    of rows
  ) {
    keyboard.push([
      {
        text:
          `🗑 ${formatDate(row.calendar_date)}`,
        callback_data:
          `calendar_del_${row.id}`
      }
    ]);
  }

  keyboard.push([
    {
      text: "◀️ Назад",
      callback_data:
        "admin_calendar"
    }
  ]);

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🗑 <b>Удаление даты</b>\n\n` +
        (
          rows.length
            ? "Выбери дату:"
            : "Удалять пока нечего."
        ),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    },
    env
  );
}


async function deleteCalendarDate(
  chatId,
  telegramId,
  calendarId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  await env.DB.prepare(
    `DELETE FROM calendar
     WHERE id = ?`
  )
    .bind(calendarId)
    .run();

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🗑 Дата удалена из календаря.`,
      reply_markup:
        backMenu(
          "admin_calendar"
        )
    },
    env
  );
}


/* =====================================================
   ADMIN — SCHEDULE
===================================================== */

async function showAdminSchedule(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "📅 Понедельник",
          callback_data:
            "admin_schedule_day_1"
        }
      ],
      [
        {
          text: "📅 Вторник",
          callback_data:
            "admin_schedule_day_2"
        }
      ],
      [
        {
          text: "📅 Среда",
          callback_data:
            "admin_schedule_day_3"
        }
      ],
      [
        {
          text: "📅 Четверг",
          callback_data:
            "admin_schedule_day_4"
        }
      ],
      [
        {
          text: "📅 Пятница",
          callback_data:
            "admin_schedule_day_5"
        }
      ],
      [
        {
          text: "◀️ Назад",
          callback_data:
            "admin"
        }
      ]
    ]
  };

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `📚 <b>Управление расписанием</b>\n\n` +
        `Выбери день недели:`,
      parse_mode: "HTML",
      reply_markup: keyboard
    },
    env
  );
}


async function showAdminScheduleDay(
  chatId,
  telegramId,
  dayOfWeek,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
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
        dayOfWeek,
        ACADEMIC_YEAR
      )
      .all();

  const rows =
    result.results || [];

  const names = {
    1: "Понедельник",
    2: "Вторник",
    3: "Среда",
    4: "Четверг",
    5: "Пятница",
    6: "Суббота",
    7: "Воскресенье"
  };

  let text =
    `📚 <b>${names[dayOfWeek]}</b>\n\n`;

  if (!rows.length) {
    text +=
      `Занятий нет.`;
  } else {
    for (
      const row
      of rows
    ) {
      text +=
        `<b>${row.lesson_number}.</b> ` +
        `${row.start_time}–${row.end_time}\n`;

      text +=
        `📖 ${row.subject}\n`;

      text +=
        `👨‍🏫 ${row.teacher || "—"}\n`;

      text +=
        `🚪 ${row.room || "—"}\n\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "➕ Добавить урок",
          callback_data:
            `admin_schedule_add_${dayOfWeek}`
        }
      ],
      [
        {
          text: "✏️ Изменить урок",
          callback_data:
            `admin_schedule_edit_${dayOfWeek}`
        }
      ],
      [
        {
          text: "🗑 Удалить урок",
          callback_data:
            `admin_schedule_delete_${dayOfWeek}`
        }
      ],
      [
        {
          text: "◀️ Назад",
          callback_data:
            "admin_schedule"
        }
      ]
    ]
  };

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard
    },
    env
  );
}


/* =====================================================
   ADMIN — ADD SCHEDULE LESSON
===================================================== */

async function beginScheduleAdd(
  chatId,
  telegramId,
  dayOfWeek,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  await setPendingInput(
    telegramId,
    {
      action:
        "schedule_add",
      dayOfWeek
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `➕ <b>Добавление урока</b>\n\n` +
        `Отправь данные одной строкой:\n\n` +
        `<code>№ | начало | конец | предмет | преподаватель | кабинет</code>\n\n` +
        `Например:\n` +
        `<code>1 | 08:30 | 09:20 | Математика | Пешкова А.В. | 6</code>`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          `admin_schedule_day_${dayOfWeek}`
        )
    },
    env
  );
}


/* =====================================================
   ADMIN — DELETE SCHEDULE LESSON
===================================================== */

async function showAdminScheduleDelete(
  chatId,
  telegramId,
  dayOfWeek,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         id,
         lesson_number,
         subject
       FROM schedule
       WHERE day_of_week = ?
         AND academic_year = ?
       ORDER BY lesson_number`
    )
      .bind(
        dayOfWeek,
        ACADEMIC_YEAR
      )
      .all();

  const rows =
    result.results || [];

  const keyboard = [];

  for (
    const row
    of rows
  ) {
    keyboard.push([
      {
        text:
          `🗑 ${row.lesson_number}. ${row.subject}`,
        callback_data:
          `admin_schedule_del_${row.id}_${dayOfWeek}`
      }
    ]);
  }

  keyboard.push([
    {
      text: "◀️ Назад",
      callback_data:
        `admin_schedule_day_${dayOfWeek}`
    }
  ]);

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🗑 <b>Удаление урока</b>\n\n` +
        `Выбери урок:`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    },
    env
  );
}


async function deleteScheduleLesson(
  chatId,
  telegramId,
  lessonId,
  dayOfWeek,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  await env.DB.prepare(
    `DELETE FROM schedule
     WHERE id = ?`
  )
    .bind(lessonId)
    .run();

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🗑 Урок удалён.`,
      reply_markup:
        backMenu(
          `admin_schedule_day_${dayOfWeek}`
        )
    },
    env
  );
}


/* =====================================================
   ADMIN — HOMEWORK
===================================================== */

async function showAdminHomework(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
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
       ORDER BY lesson_date DESC,
                lesson_number,
                id
       LIMIT 50`
    )
      .all();

  const rows =
    result.results || [];

  let text =
    `📚 <b>Управление ДЗ</b>\n\n`;

  if (!rows.length) {
    text +=
      `Домашних заданий пока нет.\n`;
  } else {
    for (
      const row
      of rows
    ) {
      text +=
        `📅 <b>${formatDate(row.lesson_date)}</b>\n`;

      text +=
        `📖 ${row.subject}\n`;

      if (
        row.lesson_number
      ) {
        text +=
          `🔢 Урок: ${row.lesson_number}\n`;
      }

      text +=
        `📝 ${row.text}\n\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "➕ Добавить ДЗ",
          callback_data:
            "admin_hw_add"
        }
      ],
      [
        {
          text: "🗑 Удалить ДЗ",
          callback_data:
            "admin_hw_delete"
        }
      ],
      [
        {
          text: "📦 Архив",
          callback_data:
            "admin_hw_archive"
        }
      ],
      [
        {
          text: "◀️ Назад",
          callback_data:
            "admin"
        }
      ]
    ]
  };

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard
    },
    env
  );
}


/* =====================================================
   ADMIN — ADD HOMEWORK
===================================================== */

async function beginHomeworkAdd(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  await setPendingInput(
    telegramId,
    {
      action:
        "homework_setup"
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `➕ <b>Добавление ДЗ</b>\n\n` +
        `Отправь данные:\n\n` +
        `<code>ДД.ММ.ГГГГ | предмет | номер урока</code>\n\n` +
        `Например:\n` +
        `<code>09.09.2026 | Математика | 3</code>`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          "admin_homework"
        )
    },
    env
  );
}


/* =====================================================
   ADMIN — DELETE HOMEWORK
===================================================== */

async function showAdminHomeworkDelete(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         id,
         lesson_date,
         subject
       FROM homework
       WHERE is_archived = 0
       ORDER BY lesson_date DESC
       LIMIT 50`
    )
      .all();

  const rows =
    result.results || [];

  const keyboard = [];

  for (
    const row
    of rows
  ) {
    keyboard.push([
      {
        text:
          `🗑 ${formatDate(row.lesson_date)} · ${row.subject}`,
        callback_data:
          `admin_hw_del_${row.id}`
      }
    ]);
  }

  keyboard.push([
    {
      text: "◀️ Назад",
      callback_data:
        "admin_homework"
    }
  ]);

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🗑 <b>Удаление ДЗ</b>\n\n` +
        `Выбери запись:`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    },
    env
  );
}


async function deleteHomework(
  chatId,
  telegramId,
  homeworkId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  await env.DB.prepare(
    `DELETE FROM homework
     WHERE id = ?`
  )
    .bind(homeworkId)
    .run();

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🗑 Домашнее задание удалено.`,
      reply_markup:
        backMenu(
          "admin_homework"
        )
    },
    env
  );
}
/* =====================================================
   ADMIN — ANNOUNCEMENTS
===================================================== */

async function showAdminAnnouncements(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         id,
         text,
         status,
         created_at
       FROM announcements
       ORDER BY id DESC
       LIMIT 30`
    )
      .all();

  const rows =
    result.results || [];

  let text =
    `📢 <b>Объявления</b>\n\n`;

  if (!rows.length) {
    text +=
      `Объявлений пока нет.`;
  } else {
    for (
      const row
      of rows
    ) {
      const status =
        row.status === "published"
          ? "🟢 опубликовано"
          : row.status === "cancelled"
            ? "🔴 отменено"
            : "🟡 черновик";

      text +=
        `#${row.id} · ${status}\n`;

      text +=
        `${row.text}\n\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "➕ Создать",
          callback_data:
            "admin_announcement_add"
        }
      ],
      [
        {
          text: "🗑 Удалить",
          callback_data:
            "admin_announcement_delete"
        }
      ],
      [
        {
          text: "◀️ Назад",
          callback_data:
            "admin"
        }
      ]
    ]
  };

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard
    },
    env
  );
}


/* =====================================================
   CREATE ANNOUNCEMENT
===================================================== */

async function beginAnnouncement(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  await setPendingInput(
    telegramId,
    {
      action:
        "announcement_text"
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `📢 <b>Новое объявление</b>\n\n` +
        `Напиши текст объявления.\n\n` +
        `После этого бот покажет предварительный просмотр перед публикацией.\n\n` +
        `Для отмены: /cancel`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          "admin_announcements"
        )
    },
    env
  );
}


/* =====================================================
   ANNOUNCEMENT PREVIEW
===================================================== */

async function showAnnouncementPreview(
  chatId,
  telegramId,
  text,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  await setPendingInput(
    telegramId,
    {
      action:
        "announcement_preview",
      text
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `📢 <b>Предпросмотр</b>\n\n` +
        `${text}\n\n` +
        `Опубликовать это объявление?`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Опубликовать",
              callback_data:
                "announcement_publish"
            }
          ],
          [
            {
              text: "✏️ Изменить",
              callback_data:
                "announcement_edit"
            }
          ],
          [
            {
              text: "❌ Отмена",
              callback_data:
                "admin_announcements"
            }
          ]
        ]
      }
    },
    env
  );
}


/* =====================================================
   PUBLISH ANNOUNCEMENT
===================================================== */

async function publishAnnouncement(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const pending =
    await getPendingInput(
      telegramId,
      env
    );

  if (
    !pending ||
    pending.action !==
      "announcement_preview" ||
    !pending.text
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⚠️ Предпросмотр объявления больше не доступен.`,
        reply_markup:
          backMenu(
            "admin_announcements"
          )
      },
      env
    );

    return;
  }

  const result =
    await env.DB.prepare(
      `INSERT INTO announcements
       (
         text,
         created_by,
         status
       )
       VALUES (?, ?, 'published')`
    )
      .bind(
        pending.text,
        telegramId
      )
      .run();

  await clearPendingInput(
    telegramId,
    env
  );

  /*
     Публикуем объявление в группе,
     если ID группы сохранён в settings.
  */
  const groupSetting =
    await env.DB.prepare(
      `SELECT value
       FROM settings
       WHERE key = 'group_chat_id'`
    )
      .first();

  if (
    groupSetting?.value
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id:
          groupSetting.value,
        text:
          `📢 <b>Объявление</b>\n\n` +
          `${pending.text}`,
        parse_mode: "HTML"
      },
      env
    );
  }

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `✅ <b>Объявление опубликовано</b>`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          "admin_announcements"
        )
    },
    env
  );
}


/* =====================================================
   EDIT ANNOUNCEMENT TEXT
===================================================== */

async function editAnnouncementInput(
  chatId,
  telegramId,
  env
) {
  const pending =
    await getPendingInput(
      telegramId,
      env
    );

  if (
    !pending ||
    !pending.text
  ) {
    await beginAnnouncement(
      chatId,
      telegramId,
      env
    );

    return;
  }

  await setPendingInput(
    telegramId,
    {
      action:
        "announcement_text"
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `✏️ <b>Измени текст объявления</b>\n\n` +
        `Отправь новый текст:`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          "admin_announcements"
        )
    },
    env
  );
}


/* =====================================================
   DELETE ANNOUNCEMENT LIST
===================================================== */

async function showAnnouncementDelete(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         id,
         text
       FROM announcements
       ORDER BY id DESC
       LIMIT 30`
    )
      .all();

  const rows =
    result.results || [];

  const keyboard = [];

  for (
    const row
    of rows
  ) {
    keyboard.push([
      {
        text:
          `🗑 #${row.id} ${row.text.substring(0, 35)}`,
        callback_data:
          `announcement_delete_${row.id}`
      }
    ]);
  }

  keyboard.push([
    {
      text: "◀️ Назад",
      callback_data:
        "admin_announcements"
    }
  ]);

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🗑 <b>Удаление объявления</b>\n\n` +
        `Выбери объявление:`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    },
    env
  );
}


async function deleteAnnouncement(
  chatId,
  telegramId,
  announcementId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  await env.DB.prepare(
    `DELETE FROM announcements
     WHERE id = ?`
  )
    .bind(announcementId)
    .run();

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🗑 Объявление удалено.`,
      reply_markup:
        backMenu(
          "admin_announcements"
        )
    },
    env
  );
}


/* =====================================================
   PUBLISHED ANNOUNCEMENTS FOR STUDENTS
===================================================== */

async function showPublishedAnnouncements(
  chatId,
  telegramId,
  env
) {
  const result =
    await env.DB.prepare(
      `SELECT
         text,
         created_at
       FROM announcements
       WHERE status = 'published'
       ORDER BY id DESC
       LIMIT 20`
    )
      .all();

  const rows =
    result.results || [];

  let text =
    `📢 <b>Объявления ПК-38</b>\n\n`;

  if (!rows.length) {
    text +=
      `Новых объявлений нет.`;
  } else {
    for (
      const row
      of rows
    ) {
      text +=
        `📢 ${row.text}\n\n`;
    }
  }

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup:
        backMenu("menu")
    },
    env
  );
}


/* =====================================================
   ADMIN — ALERTS
===================================================== */

async function showAdminAlerts(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "🚨 Оповещение",
          callback_data:
            "alert_start"
        }
      ],
      [
        {
          text: "🟢 Отбой",
          callback_data:
            "alert_end"
        }
      ],
      [
        {
          text: "◀️ Назад",
          callback_data:
            "admin"
        }
      ]
    ]
  };

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `📢 <b>Оповещения</b>\n\n` +
        `Здесь можно вручную отправить сообщение в группу.`,
      parse_mode: "HTML",
      reply_markup: keyboard
    },
    env
  );
}


/* =====================================================
   SEND MANUAL ALERT
===================================================== */

async function sendManualAlert(
  chatId,
  telegramId,
  type,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const groupSetting =
    await env.DB.prepare(
      `SELECT value
       FROM settings
       WHERE key = 'group_chat_id'`
    )
      .first();

  if (
    !groupSetting?.value
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⚠️ ID группы пока не сохранён.\n\n` +
          `Сначала добавь group_chat_id в настройках.`
      },
      env
    );

    return;
  }

  let text;

  if (
    type === "start"
  ) {
    text =
      `🚨 <b>ВНИМАНИЕ</b>\n\n` +
      `Получено оповещение.\n` +
      `Следуйте инструкциям преподавателей и администрации.`;
  } else {
    text =
      `🟢 <b>ОПОВЕЩЕНИЕ ОКОНЧЕНО</b>\n\n` +
      `Можно продолжать учебный процесс.`;
  }

  await telegram(
    "sendMessage",
    {
      chat_id:
        groupSetting.value,
      text,
      parse_mode: "HTML"
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        type === "start"
          ? `🚨 Оповещение отправлено в группу.`
          : `🟢 Сообщение об окончании отправлено в группу.`,
      reply_markup:
        backMenu("admin_alerts")
    },
    env
  );
}


/* =====================================================
   ADMIN — ATTENDANCE
===================================================== */

async function showAdminAttendance(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "📅 Сегодня",
          callback_data:
            "attendance_today"
        }
      ],
      [
        {
          text: "🗓 Выбрать дату",
          callback_data:
            "attendance_date"
        }
      ],
      [
        {
          text: "📊 За неделю",
          callback_data:
            "attendance_week"
        }
      ],
      [
        {
          text: "📈 За месяц",
          callback_data:
            "attendance_month"
        }
      ],
      [
        {
          text: "◀️ Назад",
          callback_data:
            "admin"
        }
      ]
    ]
  };

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🕐 <b>Посещаемость</b>\n\n` +
        `Выбери период:`,
      parse_mode: "HTML",
      reply_markup: keyboard
    },
    env
  );
}


/* =====================================================
   ATTENDANCE DATE INPUT
===================================================== */

async function beginAttendanceDate(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  await setPendingInput(
    telegramId,
    {
      action:
        "attendance_date"
    },
    env
  );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `🗓 <b>Выбор даты</b>\n\n` +
        `Напиши дату в формате:\n\n` +
        `<code>ДД.ММ.ГГГГ</code>\n\n` +
        `Например: <code>08.09.2026</code>`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          "admin_attendance"
        )
    },
    env
  );
}
/* =====================================================
   ATTENDANCE — DATE
===================================================== */

async function showAttendanceForDate(
  chatId,
  telegramId,
  date,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const studentsResult =
    await env.DB.prepare(
      `SELECT
         id,
         full_name
       FROM students
       WHERE is_active = 1
       ORDER BY full_name`
    )
      .all();

  const students =
    studentsResult.results || [];

  const attendanceResult =
    await env.DB.prepare(
      `SELECT
         student_id,
         status
       FROM attendance
       WHERE attendance_date = ?`
    )
      .bind(date)
      .all();

  const attendance =
    attendanceResult.results || [];

  const attendanceMap =
    new Map();

  for (
    const row
    of attendance
  ) {
    attendanceMap.set(
      Number(row.student_id),
      row.status
    );
  }

  let text =
    `🕐 <b>Посещаемость</b>\n\n` +
    `📅 ${formatDateRu(date)}\n\n`;

  const keyboard = [];

  for (
    const student
    of students
  ) {
    const status =
      attendanceMap.get(
        Number(student.id)
      ) || "none";

    let icon = "➖";

    if (status === "present") {
      icon = "✅";
    }

    if (status === "absent") {
      icon = "❌";
    }

    if (status === "late") {
      icon = "⏰";
    }

    keyboard.push([
      {
        text:
          `${icon} ${student.full_name}`,
        callback_data:
          `attendance_student_${student.id}_${date}`
      }
    ]);
  }

  keyboard.push([
    {
      text: "📊 Итоги",
      callback_data:
        `attendance_summary_${date}`
    }
  ]);

  keyboard.push([
    {
      text: "◀️ Назад",
      callback_data:
        "admin_attendance"
    }
  ]);

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    },
    env
  );
}


/* =====================================================
   ATTENDANCE — STUDENT
===================================================== */

async function showAttendanceStudent(
  chatId,
  telegramId,
  studentId,
  date,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
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

  const current =
    await env.DB.prepare(
      `SELECT status
       FROM attendance
       WHERE attendance_date = ?
       AND student_id = ?`
    )
      .bind(
        date,
        studentId
      )
      .first();

  let currentText =
    "➖ Нет данных";

  if (
    current?.status ===
    "present"
  ) {
    currentText =
      "✅ Присутствует";
  }

  if (
    current?.status ===
    "absent"
  ) {
    currentText =
      "❌ Отсутствует";
  }

  if (
    current?.status ===
    "late"
  ) {
    currentText =
      "⏰ Опоздал";
  }

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `👤 <b>${student.full_name}</b>\n\n` +
        `📅 ${formatDateRu(date)}\n` +
        `Текущий статус: ${currentText}\n\n` +
        `Выбери статус:`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Присутствует",
              callback_data:
                `attendance_set_present_${studentId}_${date}`
            }
          ],
          [
            {
              text: "❌ Отсутствует",
              callback_data:
                `attendance_set_absent_${studentId}_${date}`
            }
          ],
          [
            {
              text: "⏰ Опоздал",
              callback_data:
                `attendance_set_late_${studentId}_${date}`
            }
          ],
          [
            {
              text: "➖ Нет данных",
              callback_data:
                `attendance_set_none_${studentId}_${date}`
            }
          ],
          [
            {
              text: "◀️ К списку",
              callback_data:
                `attendance_date_view_${date}`
            }
          ]
        ]
      }
    },
    env
  );
}


/* =====================================================
   ATTENDANCE — SAVE STATUS
===================================================== */

async function setAttendanceStatus(
  chatId,
  telegramId,
  studentId,
  date,
  status,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  if (
    status === "none"
  ) {
    await env.DB.prepare(
      `DELETE FROM attendance
       WHERE attendance_date = ?
       AND student_id = ?`
    )
      .bind(
        date,
        studentId
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO attendance
       (
         attendance_date,
         student_id,
         status,
         marked_by
       )
       VALUES (?, ?, ?, ?)
       ON CONFLICT(attendance_date, student_id)
       DO UPDATE SET
         status = excluded.status,
         marked_by = excluded.marked_by`
    )
      .bind(
        date,
        studentId,
        status,
        telegramId
      )
      .run();
  }

  await showAttendanceForDate(
    chatId,
    telegramId,
    date,
    env
  );
}


/* =====================================================
   ATTENDANCE — SUMMARY
===================================================== */

async function showAttendanceSummary(
  chatId,
  telegramId,
  date,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(
           CASE
             WHEN status = 'present'
             THEN 1 ELSE 0
           END
         ) AS present,
         SUM(
           CASE
             WHEN status = 'absent'
             THEN 1 ELSE 0
           END
         ) AS absent,
         SUM(
           CASE
             WHEN status = 'late'
             THEN 1 ELSE 0
           END
         ) AS late
       FROM attendance
       WHERE attendance_date = ?`
    )
      .bind(date)
      .first();

  const studentsResult =
    await env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM students
       WHERE is_active = 1`
    )
      .first();

  const totalStudents =
    Number(
      studentsResult?.total || 0
    );

  const marked =
    Number(
      result?.total || 0
    );

  const present =
    Number(
      result?.present || 0
    );

  const absent =
    Number(
      result?.absent || 0
    );

  const late =
    Number(
      result?.late || 0
    );

  const noData =
    Math.max(
      0,
      totalStudents - marked
    );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `📊 <b>Итоги посещаемости</b>\n\n` +
        `📅 ${formatDateRu(date)}\n\n` +
        `👥 Всего: ${totalStudents}\n` +
        `✅ Присутствуют: ${present}\n` +
        `❌ Отсутствуют: ${absent}\n` +
        `⏰ Опоздали: ${late}\n` +
        `➖ Не отмечены: ${noData}`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "◀️ К посещаемости",
              callback_data:
                `attendance_date_view_${date}`
            }
          ],
          [
            {
              text: "🏠 Админ-панель",
              callback_data:
                "admin"
            }
          ]
        ]
      }
    },
    env
  );
}


/* =====================================================
   ATTENDANCE — WEEK
===================================================== */

async function showAttendanceWeek(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const today =
    getLocalDate();

  const date =
    new Date(
      `${today}T12:00:00`
    );

  const day =
    date.getDay();

  const diff =
    day === 0
      ? -6
      : 1 - day;

  date.setDate(
    date.getDate() + diff
  );

  let text =
    `📊 <b>Посещаемость за неделю</b>\n\n`;

  let totalPresent = 0;
  let totalAbsent = 0;
  let totalLate = 0;

  for (
    let i = 0;
    i < 7;
    i++
  ) {
    const current =
      new Date(date);

    current.setDate(
      date.getDate() + i
    );

    const iso =
      current
        .toISOString()
        .slice(0, 10);

    const result =
      await env.DB.prepare(
        `SELECT
           SUM(
             CASE
               WHEN status = 'present'
               THEN 1 ELSE 0
             END
           ) AS present,
           SUM(
             CASE
               WHEN status = 'absent'
               THEN 1 ELSE 0
             END
           ) AS absent,
           SUM(
             CASE
               WHEN status = 'late'
               THEN 1 ELSE 0
             END
           ) AS late
         FROM attendance
         WHERE attendance_date = ?`
      )
        .bind(iso)
        .first();

    const present =
      Number(
        result?.present || 0
      );

    const absent =
      Number(
        result?.absent || 0
      );

    const late =
      Number(
        result?.late || 0
      );

    totalPresent +=
      present;

    totalAbsent +=
      absent;

    totalLate +=
      late;

    text +=
      `📅 ${formatDateRu(iso)}\n` +
      `✅ ${present} · ` +
      `❌ ${absent} · ` +
      `⏰ ${late}\n\n`;
  }

  text +=
    `<b>Итого:</b>\n` +
    `✅ ${totalPresent}\n` +
    `❌ ${totalAbsent}\n` +
    `⏰ ${totalLate}`;

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          "admin_attendance"
        )
    },
    env
  );
}


/* =====================================================
   ATTENDANCE — MONTH
===================================================== */

async function showAttendanceMonth(
  chatId,
  telegramId,
  env
) {
  if (
    !await isAdmin(
      telegramId,
      env
    )
  ) {
    return;
  }

  const today =
    getLocalDate();

  const month =
    today.substring(
      0,
      7
    );

  const result =
    await env.DB.prepare(
      `SELECT
         SUM(
           CASE
             WHEN status = 'present'
             THEN 1 ELSE 0
           END
         ) AS present,
         SUM(
           CASE
             WHEN status = 'absent'
             THEN 1 ELSE 0
           END
         ) AS absent,
         SUM(
           CASE
             WHEN status = 'late'
             THEN 1 ELSE 0
           END
         ) AS late
       FROM attendance
       WHERE attendance_date LIKE ?`
    )
      .bind(
        `${month}%`
      )
      .first();

  const present =
    Number(
      result?.present || 0
    );

  const absent =
    Number(
      result?.absent || 0
    );

  const late =
    Number(
      result?.late || 0
    );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `📈 <b>Посещаемость за месяц</b>\n\n` +
        `🗓 ${month}\n\n` +
        `✅ Присутствовали: ${present}\n` +
        `❌ Отсутствовали: ${absent}\n` +
        `⏰ Опоздания: ${late}`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          "admin_attendance"
        )
    },
    env
  );
}


/* =====================================================
   ATTENDANCE — STUDENT PERSONAL STATS
===================================================== */

async function showMyAttendance(
  chatId,
  telegramId,
  env
) {
  const student =
    await env.DB.prepare(
      `SELECT id, full_name
       FROM students
       WHERE telegram_id = ?
       AND is_active = 1`
    )
      .bind(telegramId)
      .first();

  if (!student) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        text:
          `⚠️ Твой Telegram пока не привязан к участнику ПК-38.`
      },
      env
    );

    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT
         SUM(
           CASE
             WHEN status = 'present'
             THEN 1 ELSE 0
           END
         ) AS present,
         SUM(
           CASE
             WHEN status = 'absent'
             THEN 1 ELSE 0
           END
         ) AS absent,
         SUM(
           CASE
             WHEN status = 'late'
             THEN 1 ELSE 0
           END
         ) AS late
       FROM attendance
       WHERE student_id = ?`
    )
      .bind(student.id)
      .first();

  const present =
    Number(
      result?.present || 0
    );

  const absent =
    Number(
      result?.absent || 0
    );

  const late =
    Number(
      result?.late || 0
    );

  await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text:
        `📊 <b>Моя посещаемость</b>\n\n` +
        `👤 ${student.full_name}\n\n` +
        `✅ Присутствий: ${present}\n` +
        `❌ Отсутствий: ${absent}\n` +
        `⏰ Опозданий: ${late}`,
      parse_mode: "HTML",
      reply_markup:
        backMenu(
          "stats"
        )
    },
    env
  );
}
  /* =====================================================
     ATTENDANCE CALLBACKS
  ===================================================== */

  if (data === "admin_attendance") {
    await showAdminAttendance(
      chatId,
      telegramId,
      env
    );
    return;
  }

  if (data === "attendance_today") {
    const today =
      getLocalDate();

    await showAttendanceForDate(
      chatId,
      telegramId,
      today,
      env
    );
    return;
  }

  if (data === "attendance_date") {
    await beginAttendanceDate(
      chatId,
      telegramId,
      env
    );
    return;
  }

  if (data === "attendance_week") {
    await showAttendanceWeek(
      chatId,
      telegramId,
      env
    );
    return;
  }

  if (data === "attendance_month") {
    await showAttendanceMonth(
      chatId,
      telegramId,
      env
    );
    return;
  }

  /* =====================================================
     ATTENDANCE — OPEN DATE
  ===================================================== */

  if (
    data.startsWith(
      "attendance_date_view_"
    )
  ) {
    const date =
      data.replace(
        "attendance_date_view_",
        ""
      );

    await showAttendanceForDate(
      chatId,
      telegramId,
      date,
      env
    );
    return;
  }

  /* =====================================================
     ATTENDANCE — STUDENT
  ===================================================== */

  if (
    data.startsWith(
      "attendance_student_"
    )
  ) {
    const parts =
      data.split("_");

    const studentId =
      Number(parts[2]);

    const date =
      parts.slice(3).join("_");

    if (
      !studentId ||
      !date
    ) {
      return;
    }

    await showAttendanceStudent(
      chatId,
      telegramId,
      studentId,
      date,
      env
    );
    return;
  }

  /* =====================================================
     ATTENDANCE — SET STATUS
  ===================================================== */

  if (
    data.startsWith(
      "attendance_set_"
    )
  ) {
    const parts =
      data.split("_");

    const status =
      parts[2];

    const studentId =
      Number(parts[3]);

    const date =
      parts.slice(4).join("_");

    if (
      !studentId ||
      !date
    ) {
      return;
    }

    const allowedStatuses = [
      "present",
      "absent",
      "late",
      "none"
    ];

    if (
      !allowedStatuses.includes(
        status
      )
    ) {
      return;
    }

    await setAttendanceStatus(
      chatId,
      telegramId,
      studentId,
      date,
      status,
      env
    );
    return;
  }

  /* =====================================================
     ATTENDANCE — SUMMARY
  ===================================================== */

  if (
    data.startsWith(
      "attendance_summary_"
    )
  ) {
    const date =
      data.replace(
        "attendance_summary_",
        ""
      );

    await showAttendanceSummary(
      chatId,
      telegramId,
      date,
      env
    );
    return;
  }
