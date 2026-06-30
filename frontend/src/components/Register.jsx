import { useState } from "react"
import { deriveKeys } from "../crypto/kdf.js"
import { encryptVault } from "../crypto/vault.js"
import { api } from "../api/client.js"

export default function Register({ onSwitchToLogin }) {
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [confirm, setConfirm] = useState("")
    const [error, setError] = useState(null)
    const [loading, setLoading] = useState(false)
    const [done, setDone] = useState(false)
    

    async function handleRegister() {
        setError(null)

        if (password !== confirm) {
            setError("Passwords do not match")
            return
        }
        if (password.length < 12) {
            setError("Master password must be at least 12 characters")
            return
        }

        setLoading(true)
        try {
            // get salt from server
            const initResponse = await api.registerInit(email)
            const { salt } = initResponse

            // derive enc_key and auth_key from master password + salt
            const { encKey, authKey } = await deriveKeys(password, salt)

            // encrypt an empty vault
            const emptyVault = { entries: [] }
            const { vault_blob, iv } = await encryptVault(emptyVault, encKey)

            // register with server
            await api.registerComplete(email, authKey, vault_blob, iv, salt)

            setDone(true)
        } catch (e) {
            console.error("FULL ERROR:", e)
            console.error("ERROR STACK:", e.stack)
            setError(e.message)
        } finally {
            setLoading(false)
        }
    }

    if (done) {
        return (
            <div style={styles.container}>
                <div style={styles.card}>
                    <h2 style={styles.title}>Account created</h2>
                    <p style={styles.subtitle}>You can now log in with your master password.</p>
                    <button style={styles.button} onClick={onSwitchToLogin}>
                        Go to Login
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div style={styles.container}>
            <div style={styles.card}>
                <h1 style={styles.title}>Zero Knowledge Vault</h1>
                <p style={styles.subtitle}>Your master password never leaves your device.</p>

                {error && <div style={styles.error}>{error}</div>}

                <input
                    style={styles.input}
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                />
                <input
                    style={styles.input}
                    type="password"
                    placeholder="Master Password (min 12 characters)"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                />
                <input
                    style={styles.input}
                    type="password"
                    placeholder="Confirm Master Password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                />

                <button
                    style={loading ? styles.buttonDisabled : styles.button}
                    onClick={handleRegister}
                    disabled={loading}
                >
                    {loading ? "Deriving keys..." : "Create Account"}
                </button>

                <p style={styles.switch}>
                    Already have an account?{" "}
                    <span style={styles.link} onClick={onSwitchToLogin}>
                        Log in
                    </span>
                </p>
            </div>
        </div>
    )
}

const styles = {
    container: {
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0f0f0f",
        fontFamily: "system-ui, sans-serif"
    },
    card: {
        backgroundColor: "#1a1a1a",
        padding: "2.5rem",
        borderRadius: "12px",
        width: "100%",
        maxWidth: "420px",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        border: "1px solid #2a2a2a"
    },
    title: {
        color: "#ffffff",
        margin: 0,
        fontSize: "1.5rem",
        fontWeight: 600
    },
    subtitle: {
        color: "#888",
        margin: 0,
        fontSize: "0.875rem"
    },
    input: {
        padding: "0.75rem 1rem",
        borderRadius: "8px",
        border: "1px solid #333",
        backgroundColor: "#111",
        color: "#fff",
        fontSize: "0.95rem",
        outline: "none",
        width: "100%",
        boxSizing: "border-box"
    },
    button: {
        padding: "0.75rem",
        borderRadius: "8px",
        border: "none",
        backgroundColor: "#2563eb",
        color: "#fff",
        fontSize: "0.95rem",
        fontWeight: 600,
        cursor: "pointer",
        width: "100%"
    },
    buttonDisabled: {
        padding: "0.75rem",
        borderRadius: "8px",
        border: "none",
        backgroundColor: "#1e3a8a",
        color: "#888",
        fontSize: "0.95rem",
        fontWeight: 600,
        cursor: "not-allowed",
        width: "100%"
    },
    error: {
        backgroundColor: "#2a1515",
        border: "1px solid #7f1d1d",
        color: "#fca5a5",
        padding: "0.75rem",
        borderRadius: "8px",
        fontSize: "0.875rem"
    },
    switch: {
        color: "#888",
        fontSize: "0.875rem",
        textAlign: "center",
        margin: 0
    },
    link: {
        color: "#2563eb",
        cursor: "pointer"
    }
}