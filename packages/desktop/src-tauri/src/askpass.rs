//! The app's executable as git's askpass program (D9). The server runs git with GIT_ASKPASS set to
//! this executable and the GitHub token in GH_WRITER_GIT_TOKEN, for that one command. git runs it
//! with its prompt as the only argument and reads the answer from stdout. No shell is involved,
//! which MinGit may not have.

/// The environment variable holding the token, set by the server for one git command.
const TOKEN_VAR: &str = "GH_WRITER_GIT_TOKEN";

/// Whether the app was started by git to answer a prompt rather than to open a window.
pub fn is_prompt(args: &[String]) -> bool {
    matches!(args, [prompt] if prompt.starts_with("Username for ") || prompt.starts_with("Password for "))
}

/// The answer to git's prompt: GitHub's token user, or the token. None without a token.
pub fn answer(prompt: &str, token: Option<&str>) -> Option<String> {
    let token = token.filter(|t| !t.is_empty())?;
    if prompt.starts_with("Username for ") {
        Some("x-access-token".into())
    } else if prompt.starts_with("Password for ") {
        Some(token.into())
    } else {
        None
    }
}

/// Answer git's prompt on stdout and exit: 0 with an answer, 1 without one.
pub fn run(prompt: &str) -> ! {
    match answer(prompt, std::env::var(TOKEN_VAR).ok().as_deref()) {
        Some(answer) => {
            println!("{answer}");
            std::process::exit(0);
        }
        None => std::process::exit(1),
    }
}

#[cfg(test)]
mod tests {
    use super::{answer, is_prompt};

    #[test]
    fn knows_gits_prompts_from_a_launch() {
        assert!(is_prompt(&["Username for 'https://github.com': ".into()]));
        assert!(is_prompt(&["Password for 'https://x-access-token@github.com': ".into()]));
        assert!(!is_prompt(&[]));
        assert!(!is_prompt(&["/home/ada/novels/varn".into()]));
        assert!(!is_prompt(&["Username for 'https://github.com': ".into(), "more".into()]));
    }

    #[test]
    fn answers_with_the_token_user_and_the_token() {
        assert_eq!(answer("Username for 'https://github.com': ", Some("gho_t")), Some("x-access-token".into()));
        assert_eq!(answer("Password for 'https://x-access-token@github.com': ", Some("gho_t")), Some("gho_t".into()));
    }

    #[test]
    fn answers_nothing_without_a_token_or_to_anything_else() {
        assert_eq!(answer("Username for 'https://github.com': ", None), None);
        assert_eq!(answer("Password for 'https://github.com': ", Some("")), None);
        assert_eq!(answer("Enter passphrase for key: ", Some("gho_t")), None);
    }
}
