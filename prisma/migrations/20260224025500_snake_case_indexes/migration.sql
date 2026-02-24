-- Rename primary key indexes (also renames the constraint)
ALTER INDEX "User_pkey" RENAME TO "users_pkey";
ALTER INDEX "Account_pkey" RENAME TO "accounts_pkey";
ALTER INDEX "Session_pkey" RENAME TO "sessions_pkey";
ALTER INDEX "Status_pkey" RENAME TO "statuses_pkey";
ALTER INDEX "Label_pkey" RENAME TO "labels_pkey";
ALTER INDEX "Doc_pkey" RENAME TO "docs_pkey";
ALTER INDEX "Comment_pkey" RENAME TO "comments_pkey";
ALTER INDEX "DocLabel_pkey" RENAME TO "doc_labels_pkey";

-- Rename unique indexes
ALTER INDEX "User_email_key" RENAME TO "users_email_key";
ALTER INDEX "Account_provider_providerAccountId_key" RENAME TO "accounts_provider_provider_account_id_key";
ALTER INDEX "Session_sessionToken_key" RENAME TO "sessions_session_token_key";
ALTER INDEX "VerificationToken_token_key" RENAME TO "verification_tokens_token_key";
ALTER INDEX "VerificationToken_identifier_token_key" RENAME TO "verification_tokens_identifier_token_key";
ALTER INDEX "Label_userId_name_key" RENAME TO "labels_user_id_name_key";
ALTER INDEX "Doc_userId_googleDocId_key" RENAME TO "docs_user_id_google_doc_id_key";
ALTER INDEX "Comment_docId_googleCommentId_key" RENAME TO "comments_doc_id_google_comment_id_key";

-- Rename foreign key constraints
ALTER TABLE "accounts" RENAME CONSTRAINT "Account_userId_fkey" TO "accounts_user_id_fkey";
ALTER TABLE "sessions" RENAME CONSTRAINT "Session_userId_fkey" TO "sessions_user_id_fkey";
ALTER TABLE "statuses" RENAME CONSTRAINT "Status_userId_fkey" TO "statuses_user_id_fkey";
ALTER TABLE "labels" RENAME CONSTRAINT "Label_userId_fkey" TO "labels_user_id_fkey";
ALTER TABLE "docs" RENAME CONSTRAINT "Doc_userId_fkey" TO "docs_user_id_fkey";
ALTER TABLE "comments" RENAME CONSTRAINT "Comment_docId_fkey" TO "comments_doc_id_fkey";
ALTER TABLE "doc_labels" RENAME CONSTRAINT "DocLabel_docId_fkey" TO "doc_labels_doc_id_fkey";
ALTER TABLE "doc_labels" RENAME CONSTRAINT "DocLabel_labelId_fkey" TO "doc_labels_label_id_fkey";
