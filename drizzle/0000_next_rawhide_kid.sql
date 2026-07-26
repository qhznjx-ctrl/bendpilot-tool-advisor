CREATE TABLE `dxf_geometries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article_number` text NOT NULL,
	`kind` text NOT NULL,
	`points` text NOT NULL,
	`source` text DEFAULT 'user-upload' NOT NULL,
	`validated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
