const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

    const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 14335),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "daily_work_tracker",

    ssl: {
        rejectUnauthorized: false
    },

    waitForConnections: true,
    connectionLimit: 10
});


/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", async (req, res) => {
    try {
        const [rows] = await db.query("SELECT 1 AS connected");

        res.json({
            success: true,
            message: "Daily Work Tracker Backend is running",
            database: rows[0].connected === 1
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Database connection failed",
            error: error.message
        });
    }
});


/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: "Username/email and password are required."
            });
        }

        /* ADMIN LOGIN */

        const [admins] = await db.query(
            `SELECT id, username
             FROM admin_users
             WHERE username = ? AND password = ?
             LIMIT 1`,
            [username, password]
        );

        if (admins.length) {
            return res.json({
                success: true,
                role: "admin",
                user: {
                    id: admins[0].id,
                    username: admins[0].username,
                    name: "Administrator"
                }
            });
        }

        /* EMPLOYEE LOGIN */

        const [employees] = await db.query(
            `SELECT id, name, designation, email
             FROM employees
             WHERE LOWER(email) = LOWER(?)
             AND password = ?
             AND is_active = 1
             LIMIT 1`,
            [username, password]
        );

        if (employees.length) {
            return res.json({
                success: true,
                role: "employee",
                user: {
                    id: employees[0].id,
                    name: employees[0].name,
                    designation: employees[0].designation,
                    email: employees[0].email
                }
            });
        }

        return res.status(401).json({
            success: false,
            message: "Invalid email/username or password."
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


/* =========================================================
   EMPLOYEES
========================================================= */

app.get("/api/employees", async (req, res) => {
    try {
        const [employees] = await db.query(`
            SELECT
                id,
                name,
                designation,
                email,
                is_active,
                created_at
            FROM employees
            ORDER BY name
        `);

        res.json({
            success: true,
            employees
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/* DEFAULT PASSWORD
   First 2 letters of first name
   + last 2 letters of last name
*/

function defaultPassword(name) {
    const parts = name.trim().split(/\s+/);

    const first = (parts[0] || "").slice(0, 2);
    const lastPart =
        parts.length > 1
            ? parts[parts.length - 1]
            : parts[0];

    const last = (lastPart || "").slice(-2);

    return first + last;
}


/* ADD EMPLOYEE */

app.post("/api/employees", async (req, res) => {
    try {
        const {
            name,
            designation,
            email
        } = req.body;

        if (!name || !email) {
            return res.status(400).json({
                success: false,
                message: "Name and email are required."
            });
        }

        const password = defaultPassword(name);

        const [result] = await db.query(`
            INSERT INTO employees
            (
                name,
                designation,
                email,
                password,
                is_active
            )
            VALUES (?, ?, ?, ?, 1)
        `, [
            name.trim(),
            designation || "Team Member",
            email.trim().toLowerCase(),
            password
        ]);

        const [rows] = await db.query(
            `SELECT id, name, designation, email, is_active
             FROM employees
             WHERE id = ?`,
            [result.insertId]
        );

        res.json({
            success: true,
            message: "Employee added successfully.",
            employee: rows[0],
            defaultPassword: password
        });

    } catch (error) {
        console.error(error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "Email already exists."
            });
        }

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/* =========================================================
   TASKS
========================================================= */

/* GET TASKS FOR EMPLOYEE + DATE */

app.get("/api/tasks/:employeeId/:date", async (req, res) => {
    try {
        const {
            employeeId,
            date
        } = req.params;

        const [tasks] = await db.query(`
            SELECT *
            FROM tasks
            WHERE employee_id = ?
            AND task_date = ?
            ORDER BY
                FIELD(priority,
                    'Urgent',
                    'High',
                    'Medium',
                    'Low'
                ),
                id DESC
        `, [
            employeeId,
            date
        ]);

        res.json({
            success: true,
            tasks
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/* ADD TASK */

app.post("/api/tasks", async (req, res) => {
    try {
        const {
            employee_id,
            title,
            description,
            priority,
            category,
            estimated_time,
            admin_notes,
            task_date,
            due_date,
            recurrence,
            status
        } = req.body;

        if (!employee_id || !title || !task_date) {
            return res.status(400).json({
                success: false,
                message:
                    "Employee, task title and task date are required."
            });
        }

        const allowedPriority = [
            "Low",
            "Medium",
            "High",
            "Urgent"
        ];

        const allowedStatus = [
            "pending",
            "in_progress",
            "completed"
        ];

        const finalPriority =
            allowedPriority.includes(priority)
                ? priority
                : "Medium";

        const finalStatus =
            allowedStatus.includes(status)
                ? status
                : "pending";

        const finalRecurrence = [
            "none",
            "daily",
            "weekly",
            "monthly"
        ].includes(recurrence)
            ? recurrence
            : "none";

        const [result] = await db.query(`
            INSERT INTO tasks
            (
                employee_id,
                title,
                description,
                priority,
                category,
                estimated_time,
                admin_notes,
                task_date,
                due_date,
                recurrence,
                status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            employee_id,
            title,
            description || null,
            finalPriority,
            category || null,
            estimated_time || null,
            admin_notes || null,
            task_date,
            due_date || null,
            finalRecurrence,
            finalStatus
        ]);

        const [rows] = await db.query(
            `SELECT * FROM tasks WHERE id = ?`,
            [result.insertId]
        );

        io.emit("taskAssigned", rows[0]);

        res.json({
            success: true,
            message: "Task assigned successfully.",
            task: rows[0]
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/* UPDATE TASK STATUS */

app.put("/api/tasks/:id/status", async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const allowedStatuses = [
            "pending",
            "in_progress",
            "completed"
        ];

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid task status."
            });
        }

        await db.query(
            `UPDATE tasks
             SET status = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [status, id]
        );

        const [rows] = await db.query(
            `SELECT * FROM tasks WHERE id = ?`,
            [id]
        );

        io.emit("taskUpdated", rows[0]);

        res.json({
            success: true,
            task: rows[0]
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/* DELETE TASK */

app.delete("/api/tasks/:id", async (req, res) => {
    try {
        const { id } = req.params;

        await db.query(
            `DELETE FROM tasks WHERE id = ?`,
            [id]
        );

        io.emit("taskDeleted", {
            id: Number(id)
        });

        res.json({
            success: true,
            message: "Task deleted."
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/* =========================================================
   TODAY'S WORK SUBMISSION
========================================================= */

app.post("/api/work-submissions", async (req, res) => {
    try {
        const {
            employee_id,
            submission_date,
            completed_tasks,
            pending_tasks,
            in_progress_tasks,
            task_snapshot
        } = req.body;

        if (!employee_id || !submission_date) {
            return res.status(400).json({
                success: false,
                message: "Employee and submission date are required."
            });
        }

        await db.query(`
            INSERT INTO work_submissions
            (
                employee_id,
                submission_date,
                completed_tasks,
                pending_tasks,
                in_progress_tasks,
                task_snapshot,
                submitted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)

            ON DUPLICATE KEY UPDATE
                completed_tasks = VALUES(completed_tasks),
                pending_tasks = VALUES(pending_tasks),
                in_progress_tasks = VALUES(in_progress_tasks),
                task_snapshot = VALUES(task_snapshot),
                submitted_at = CURRENT_TIMESTAMP
        `, [
            employee_id,
            submission_date,
            completed_tasks || 0,
            pending_tasks || 0,
            in_progress_tasks || 0,
            JSON.stringify(task_snapshot || [])
        ]);

        const [rows] = await db.query(`
            SELECT *
            FROM work_submissions
            WHERE employee_id = ?
            AND submission_date = ?
        `, [
            employee_id,
            submission_date
        ]);

        io.emit("workSubmitted", rows[0]);

        res.json({
            success: true,
            message: "Today's work submitted successfully.",
            submission: rows[0]
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/* GET WORK SUBMISSION */

app.get(
    "/api/work-submissions/:employeeId/:date",
    async (req, res) => {
        try {
            const {
                employeeId,
                date
            } = req.params;

            const [rows] = await db.query(`
                SELECT *
                FROM work_submissions
                WHERE employee_id = ?
                AND submission_date = ?
                LIMIT 1
            `, [
                employeeId,
                date
            ]);

            res.json({
                success: true,
                submitted: rows.length > 0,
                submission: rows[0] || null
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);


/* =========================================================
   EOD REPORT
========================================================= */

app.post("/api/eod-reports", async (req, res) => {
    try {
        const {
            employee_id,
            report_date,
            additional_work,
            pending_reason,
            blockers,
            tomorrow_plan,
            overall_status
        } = req.body;

        if (!employee_id || !report_date) {
            return res.status(400).json({
                success: false,
                message: "Employee and report date are required."
            });
        }

        const allowedStatus = [
            "Completed",
            "Partially Completed",
            "Pending"
        ];

        const finalStatus =
            allowedStatus.includes(overall_status)
                ? overall_status
                : "Pending";

        await db.query(`
            INSERT INTO eod_reports
            (
                employee_id,
                report_date,
                additional_work,
                pending_reason,
                blockers,
                tomorrow_plan,
                overall_status,
                submitted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)

            ON DUPLICATE KEY UPDATE
                additional_work = VALUES(additional_work),
                pending_reason = VALUES(pending_reason),
                blockers = VALUES(blockers),
                tomorrow_plan = VALUES(tomorrow_plan),
                overall_status = VALUES(overall_status),
                submitted_at = CURRENT_TIMESTAMP
        `, [
            employee_id,
            report_date,
            additional_work || "",
            pending_reason || "",
            blockers || "",
            tomorrow_plan || "",
            finalStatus
        ]);

        const [rows] = await db.query(`
            SELECT *
            FROM eod_reports
            WHERE employee_id = ?
            AND report_date = ?
        `, [
            employee_id,
            report_date
        ]);

        io.emit("eodSubmitted", rows[0]);

        res.json({
            success: true,
            message: "EOD submitted successfully.",
            report: rows[0]
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/* GET EOD */

app.get(
    "/api/eod-reports/:employeeId/:date",
    async (req, res) => {
        try {
            const {
                employeeId,
                date
            } = req.params;

            const [rows] = await db.query(`
                SELECT *
                FROM eod_reports
                WHERE employee_id = ?
                AND report_date = ?
                LIMIT 1
            `, [
                employeeId,
                date
            ]);

            res.json({
                success: true,
                submitted: rows.length > 0,
                report: rows[0] || null
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);


/* =========================================================
   ADMIN REPORTING
========================================================= */

app.get("/api/admin/work-submissions", async (req, res) => {
    try {
        const { date } = req.query;

        let sql = `
            SELECT
                ws.*,
                e.name,
                e.designation,
                e.email
            FROM work_submissions ws
            INNER JOIN employees e
                ON e.id = ws.employee_id
        `;

        const params = [];

        if (date) {
            sql += ` WHERE ws.submission_date = ?`;
            params.push(date);
        }

        sql += ` ORDER BY e.name`;

        const [rows] = await db.query(sql, params);

        res.json({
            success: true,
            submissions: rows
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


app.get("/api/admin/eod-reports", async (req, res) => {
    try {
        const { date } = req.query;

        let sql = `
            SELECT
                er.*,
                e.name,
                e.designation,
                e.email
            FROM eod_reports er
            INNER JOIN employees e
                ON e.id = er.employee_id
        `;

        const params = [];

        if (date) {
            sql += ` WHERE er.report_date = ?`;
            params.push(date);
        }

        sql += ` ORDER BY e.name`;

        const [rows] = await db.query(sql, params);

        res.json({
            success: true,
            reports: rows
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/* =========================================================
   SOCKET.IO
========================================================= */

io.on("connection", socket => {

    console.log("Client connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });

});


/* =========================================================
   SERVER
========================================================= */

const PORT = process.env.PORT || 3000;


server.listen(PORT, () => {
    console.log(
        `Daily Work Tracker running on http://localhost:${PORT}`
    );
});